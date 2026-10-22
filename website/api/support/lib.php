<?php
// ZOOD PDF support relay: the shared code. See README.md.
declare(strict_types=1);

const RELAY_VERSION = 1;

final class Fail extends Exception
{
    public function __construct(public int $status, string $message)
    {
        parent::__construct($message);
    }
}

function settings(): array
{
    static $config = null;
    if ($config === null) {
        $file = getenv('ZOOD_RELAY_CONFIG') ?: __DIR__ . '/config.php';
        if (!is_file($file)) throw new Fail(503, 'not set up');
        $config = require $file;
        $config += [
            'allowed_origins' => ['*'],
            'ideas_need_approval' => true,
            'github_api' => 'https://api.github.com',
            'github_token' => '',
            'github_repo' => '',
        ];
    }
    return $config;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $c = settings();
    $pdo = new PDO($c['db_dsn'], $c['db_user'] ?? null, $c['db_password'] ?? null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    migrate($pdo);
    return $pdo;
}

/** The tables, made on the first call. Plain SQL that MySQL and SQLite both take. */
function migrate(PDO $pdo): void
{
    $big = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? 'LONGTEXT' : 'TEXT';
    $suffix = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' DEFAULT CHARSET=utf8mb4' : '';
    $pdo->exec("CREATE TABLE IF NOT EXISTS zs_tickets (
        id VARCHAR(32) PRIMARY KEY, token_hash VARCHAR(64) NOT NULL, install_hash VARCHAR(64) NOT NULL,
        kind VARCHAR(16) NOT NULL, summary VARCHAR(200) NOT NULL, created INTEGER NOT NULL,
        issue_number INTEGER NULL, status VARCHAR(16) NOT NULL DEFAULT 'open', fixed_in VARCHAR(40) NULL,
        reply TEXT NULL, checked INTEGER NOT NULL DEFAULT 0, payload $big NULL)$suffix");
    $pdo->exec("CREATE TABLE IF NOT EXISTS zs_ideas (
        id VARCHAR(32) PRIMARY KEY, title VARCHAR(200) NOT NULL, body TEXT NOT NULL, lang VARCHAR(8) NOT NULL,
        install_hash VARCHAR(64) NOT NULL, created INTEGER NOT NULL, votes INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'open', hidden INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
        issue_number INTEGER NULL, shipped_in VARCHAR(40) NULL, synced_votes INTEGER NOT NULL DEFAULT -1)$suffix");
    $pdo->exec("CREATE TABLE IF NOT EXISTS zs_votes (
        idea_id VARCHAR(32) NOT NULL, install_hash VARCHAR(64) NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY (idea_id, install_hash))$suffix");
    $pdo->exec("CREATE TABLE IF NOT EXISTS zs_hits (
        bucket VARCHAR(120) PRIMARY KEY, hits INTEGER NOT NULL, until_at INTEGER NOT NULL)$suffix");
}

function hash_of(string $value): string
{
    return hash_hmac('sha256', $value, (string) settings()['salt']);
}

function new_id(): string
{
    return bin2hex(random_bytes(8));
}

/** At most $max calls per $seconds for this bucket; a 429 after that. */
function limit(string $name, string $who, int $max, int $seconds): void
{
    $pdo = db();
    $now = time();
    $bucket = substr($name . ':' . hash_of($who), 0, 120);
    $row = $pdo->prepare('SELECT hits, until_at FROM zs_hits WHERE bucket = ?');
    $row->execute([$bucket]);
    $found = $row->fetch();
    if (!$found || (int) $found['until_at'] < $now) {
        $pdo->prepare('DELETE FROM zs_hits WHERE bucket = ?')->execute([$bucket]);
        $pdo->prepare('INSERT INTO zs_hits (bucket, hits, until_at) VALUES (?, 1, ?)')->execute([$bucket, $now + $seconds]);
        return;
    }
    if ((int) $found['hits'] >= $max) throw new Fail(429, 'too many');
    $pdo->prepare('UPDATE zs_hits SET hits = hits + 1 WHERE bucket = ?')->execute([$bucket]);
}

function client_ip(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

function install_of(mixed $value): string
{
    if (!is_string($value) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $value)) {
        throw new Fail(400, 'install');
    }
    return $value;
}

/** Text from the app: a string, trimmed, without control characters, at most $max characters. */
function text_of(mixed $value, int $max, int $min = 0): string
{
    if ($value === null) $value = '';
    if (!is_string($value)) throw new Fail(400, 'text');
    $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value) ?? '';
    $value = trim($value);
    if (mb_strlen($value) < $min) throw new Fail(400, 'too short');
    return mb_substr($value, 0, $max);
}

/** Text that goes into a GitHub issue: no mentions, no HTML, quoted. */
function quoted(string $text): string
{
    $text = str_replace(['@', '<', '>'], ['@' . "\u{200B}", '&lt;', '&gt;'], $text);
    return implode("\n", array_map(fn($line) => '> ' . $line, explode("\n", $text)));
}

/* ------------------------------------------------------------------ GitHub */

function github_ready(): bool
{
    $c = settings();
    return $c['github_token'] !== '' && $c['github_repo'] !== '';
}

function github(string $method, string $path, ?array $body = null): array
{
    $c = settings();
    $url = rtrim($c['github_api'], '/') . '/repos/' . $c['github_repo'] . $path;
    $curl = curl_init($url);
    $headers = [
        'Accept: application/vnd.github+json',
        'Authorization: Bearer ' . $c['github_token'],
        'User-Agent: zood-support-relay',
        'X-GitHub-Api-Version: 2022-11-28',
    ];
    if ($body !== null) $headers[] = 'Content-Type: application/json';
    curl_setopt_array($curl, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_CONNECTTIMEOUT => 8,
    ]);
    if ($body !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    $raw = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    if ($raw === false || $status < 200 || $status >= 300) {
        throw new RuntimeException("github $method $path: $status");
    }
    $data = json_decode((string) $raw, true);
    return is_array($data) ? $data : [];
}

function labels_of(array $issue): array
{
    return array_map(fn($label) => strtolower((string) ($label['name'] ?? '')), $issue['labels'] ?? []);
}

/** "fixed in 0.5.0" / "shipped in 0.5.0" → "0.5.0". */
function version_label(array $labels, string $prefix): ?string
{
    foreach ($labels as $label) {
        if (str_starts_with($label, $prefix)) {
            $version = trim(substr($label, strlen($prefix)));
            if ($version !== '') return mb_substr($version, 0, 40);
        }
    }
    return null;
}

/** Files a ticket kept in the database as an issue, its picture first. Returns the issue number. */
function file_ticket(array $ticket, array $payload): int
{
    $c = settings();
    $picture = '';
    if (!empty($payload['picture'])) {
        [$type, $data] = explode(',', (string) $payload['picture'], 2) + ['', ''];
        $extension = str_contains($type, 'png') ? 'png' : 'jpg';
        $path = "pictures/{$ticket['id']}.$extension";
        github('PUT', "/contents/$path", ['message' => "Picture for ticket {$ticket['id']}", 'content' => $data]);
        $picture = "\n\n![picture](https://github.com/{$c['github_repo']}/blob/HEAD/$path?raw=true)";
    }
    // The app's facts are the sender's words too: no mentions, markup or new lines in the issue.
    $fact = fn($value) => mb_substr(preg_replace('/[@<>`\[\]\r\n|*_#!]+/u', ' ', (string) $value), 0, 80);
    $facts = implode(' · ', array_filter([
        $fact($payload['app'] ?? ''),
        $fact($payload['platform'] ?? ''),
        $fact($payload['lang'] ?? ''),
        $fact($payload['screen'] ?? ''),
    ]));
    $contact = ($payload['contact'] ?? '') !== '' ? "\n**Contact:** " . str_replace('@', '@' . "\u{200B}", (string) $payload['contact']) : '';
    $log = ($payload['log'] ?? '') !== ''
        ? "\n\n<details><summary>App log</summary>\n\n```text\n" . str_replace('```', "'''", (string) $payload['log']) . "\n```\n</details>"
        : '';
    $body = "**From the app** · ticket `{$ticket['id']}` · $facts$contact\n\n" . quoted((string) $payload['text']) . $picture . $log
        . "\n\n---\n<sub>The person sees this ticket's status in the app: label **in progress** while you work on it; close it when done, "
        . "with a label **fixed in 0.5.0** for the version that has the fix. A comment that starts with **Reply:** is shown to them.</sub>";
    $issue = github('POST', '/issues', [
        'title' => '[Ticket] ' . $ticket['summary'],
        'body' => $body,
        'labels' => ['ticket', 'kind: ' . $ticket['kind']],
    ]);
    return (int) ($issue['number'] ?? 0);
}

function idea_body(array $idea): string
{
    return quoted($idea['body'] !== '' ? $idea['body'] : $idea['title'])
        . "\n\n**Votes: {$idea['votes']}** · idea `{$idea['id']}` · {$idea['lang']}"
        . "\n\n---\n<sub>Labels change what people see in the app: **planned**, **building**, **shipped** (with **shipped in 0.5.0**), "
        . "**hidden** to take it off the board" . (settings()['ideas_need_approval'] ? ', **approved** to show it' : '') . '. Closing it as not planned hides it too.</sub>';
}

function file_idea(array $idea): int
{
    $issue = github('POST', '/issues', [
        'title' => '[Idea] ' . $idea['title'],
        'body' => idea_body($idea),
        'labels' => ['idea'],
    ]);
    return (int) ($issue['number'] ?? 0);
}

/**
 * Brings GitHub and the database together: tickets that could not be filed
 * are filed, vote counts are written onto the idea issues, and the labels
 * you set on GitHub come back as each idea's status. Run by cron (sync.php),
 * and at most every 15 minutes after an ideas request.
 */
function sync(int $budgetSeconds = 25): array
{
    if (!github_ready()) return ['skipped' => 'no github'];
    $pdo = db();
    $started = time();
    $done = ['tickets' => 0, 'ideas' => 0, 'votes' => 0];
    $pending = $pdo->query('SELECT * FROM zs_tickets WHERE issue_number IS NULL AND payload IS NOT NULL ORDER BY created LIMIT 20')->fetchAll();
    foreach ($pending as $ticket) {
        if (time() - $started > $budgetSeconds) break;
        try {
            $number = file_ticket($ticket, json_decode((string) $ticket['payload'], true) ?: []);
            $pdo->prepare('UPDATE zs_tickets SET issue_number = ?, payload = NULL WHERE id = ?')->execute([$number, $ticket['id']]);
            $done['tickets']++;
        } catch (Throwable) {
            break;
        }
    }
    foreach ($pdo->query('SELECT * FROM zs_ideas WHERE issue_number IS NULL ORDER BY created LIMIT 20')->fetchAll() as $idea) {
        if (time() - $started > $budgetSeconds) break;
        try {
            $number = file_idea($idea);
            $pdo->prepare('UPDATE zs_ideas SET issue_number = ?, synced_votes = votes WHERE id = ?')->execute([$number, $idea['id']]);
            $done['ideas']++;
        } catch (Throwable) {
            break;
        }
    }
    foreach ($pdo->query('SELECT * FROM zs_ideas WHERE issue_number IS NOT NULL AND votes <> synced_votes LIMIT 50')->fetchAll() as $idea) {
        if (time() - $started > $budgetSeconds) break;
        try {
            github('PATCH', '/issues/' . $idea['issue_number'], ['body' => idea_body($idea)]);
            $pdo->prepare('UPDATE zs_ideas SET synced_votes = ? WHERE id = ?')->execute([$idea['votes'], $idea['id']]);
            $done['votes']++;
        } catch (Throwable) {
            break;
        }
    }
    // Labels back from GitHub, a hundred ideas a page.
    for ($page = 1; $page <= 10 && time() - $started <= $budgetSeconds; $page++) {
        try {
            $issues = github('GET', "/issues?labels=idea&state=all&per_page=100&page=$page");
        } catch (Throwable) {
            break;
        }
        foreach ($issues as $issue) {
            $labels = labels_of($issue);
            $closed = ($issue['state'] ?? '') === 'closed';
            $notPlanned = $closed && ($issue['state_reason'] ?? '') === 'not_planned';
            $status = in_array('shipped', $labels, true) || ($closed && !$notPlanned) ? 'shipped'
                : (in_array('building', $labels, true) ? 'building'
                : (in_array('planned', $labels, true) ? 'planned' : 'open'));
            $hidden = in_array('hidden', $labels, true) || $notPlanned ? 1 : 0;
            $approved = in_array('approved', $labels, true) ? 1 : 0;
            $pdo->prepare('UPDATE zs_ideas SET status = ?, hidden = ?, approved = ?, shipped_in = ? WHERE issue_number = ?')
                ->execute([$status, $hidden, $approved, version_label($labels, 'shipped in '), (int) ($issue['number'] ?? 0)]);
        }
        if (count($issues) < 100) break;
    }
    $pdo->prepare('DELETE FROM zs_hits WHERE until_at < ?')->execute([time()]);
    return $done;
}
