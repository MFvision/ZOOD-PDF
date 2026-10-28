<?php
// ZOOD PDF support relay. The app's Help & Support calls it with ?a=…:
//   GET  ping                       is the relay here?
//   POST ticket                     report a problem (filed on GitHub, private)
//   GET  status&tickets=id:token,…  how this install's reports stand
//   GET  ideas                      the ideas board, with this install's votes
//   POST idea                       a new idea
//   POST vote                       one install, one vote per idea (on / off)
// Every answer is JSON with "ok". See README.md.
declare(strict_types=1);
require __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function answer(int $status, array $data): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $allowed = settings()['allowed_origins'];
    if (in_array('*', $allowed, true)) header('Access-Control-Allow-Origin: *');
    elseif ($origin !== '' && in_array($origin, $allowed, true)) {
        header("Access-Control-Allow-Origin: $origin");
        header('Vary: Origin');
    }
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Zood-App');
    header('Access-Control-Max-Age: 86400');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'OPTIONS') answer(204, ['ok' => true]);

    $action = (string) ($_GET['a'] ?? '');
    if ($action === 'ping') answer(200, ['ok' => true, 'version' => RELAY_VERSION, 'github' => github_ready()]);
    if (($_SERVER['HTTP_X_ZOOD_APP'] ?? '') === '') throw new Fail(403, 'app only');

    $input = [];
    if ($method === 'POST') {
        $raw = file_get_contents('php://input', false, null, 0, 3_000_000);
        $input = json_decode((string) $raw, true);
        if (!is_array($input)) throw new Fail(400, 'json');
    }
    $ip = client_ip();

    switch ("$method $action") {
        case 'POST ticket':
            $install = install_of($input['install'] ?? null);
            limit('ticket', $install, 5, 3600);
            limit('ticket-ip', $ip, 20, 3600);
            $kind = in_array($input['kind'] ?? '', ['bug', 'file', 'question', 'other'], true) ? $input['kind'] : 'other';
            $text = text_of($input['text'] ?? '', 4000, 5);
            $picture = $input['picture'] ?? null;
            if ($picture !== null) {
                if (!is_string($picture) || !preg_match('#^data:image/(jpeg|png);base64,[A-Za-z0-9+/=]+$#', $picture) || strlen($picture) > 2_100_000) {
                    throw new Fail(400, 'picture');
                }
            }
            $payload = [
                'text' => $text,
                'contact' => text_of($input['contact'] ?? '', 200),
                'app' => text_of($input['app'] ?? '', 80),
                'platform' => text_of($input['platform'] ?? '', 120),
                'lang' => text_of($input['lang'] ?? '', 8),
                'screen' => text_of($input['screen'] ?? '', 20),
                'log' => text_of($input['log'] ?? '', 24000),
                'picture' => $picture,
            ];
            $line = trim(explode("\n", $text)[0]);
            $ticket = [
                'id' => new_id(),
                'kind' => $kind,
                'summary' => mb_substr($line, 0, 80),
            ];
            $token = bin2hex(random_bytes(16));
            db()->prepare('INSERT INTO zs_tickets (id, token_hash, install_hash, kind, summary, created, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$ticket['id'], hash_of($token), hash_of($install), $kind, $ticket['summary'], time(), json_encode($payload, JSON_UNESCAPED_UNICODE)]);
            $number = null;
            if (github_ready()) {
                try {
                    $number = file_ticket($ticket, $payload);
                    db()->prepare('UPDATE zs_tickets SET issue_number = ?, payload = NULL WHERE id = ?')->execute([$number, $ticket['id']]);
                } catch (Throwable) {
                    // Kept with its payload; the next sync files it.
                }
            }
            answer(200, ['ok' => true, 'id' => $ticket['id'], 'token' => $token, 'number' => $number]);

        case 'GET status':
            $install = install_of($_GET['install'] ?? null);
            limit('status', $ip, 120, 3600);
            $out = [];
            $pairs = array_slice(explode(',', (string) ($_GET['tickets'] ?? '')), 0, 20);
            foreach ($pairs as $pair) {
                [$id, $token] = explode(':', $pair, 2) + ['', ''];
                if (!preg_match('/^[0-9a-f]{16}$/', $id) || !preg_match('/^[0-9a-f]{32}$/', $token)) continue;
                $row = db()->prepare('SELECT * FROM zs_tickets WHERE id = ?');
                $row->execute([$id]);
                $ticket = $row->fetch();
                if (!$ticket || !hash_equals($ticket['token_hash'], hash_of($token)) || !hash_equals($ticket['install_hash'], hash_of($install))) continue;
                if ($ticket['issue_number'] && github_ready() && time() - (int) $ticket['checked'] > 600) {
                    try {
                        $issue = github('GET', '/issues/' . $ticket['issue_number']);
                        $labels = labels_of($issue);
                        $status = ($issue['state'] ?? '') === 'closed' ? 'resolved' : (in_array('in progress', $labels, true) ? 'in_progress' : 'open');
                        $reply = $ticket['reply'];
                        if ((int) ($issue['comments'] ?? 0) > 0) {
                            foreach (array_reverse(github('GET', '/issues/' . $ticket['issue_number'] . '/comments?per_page=100')) as $comment) {
                                $body = trim((string) ($comment['body'] ?? ''));
                                $role = $comment['author_association'] ?? '';
                                if (in_array($role, ['OWNER', 'MEMBER', 'COLLABORATOR'], true) && preg_match('/^reply:\s*(.+)$/is', $body, $match)) {
                                    // A signature under a --- rule (the footer some tools add) is not part of the reply.
                                    $reply = mb_substr(trim((string) preg_replace('/\R\s*-{3,}\s*\R.*$/su', '', $match[1])), 0, 1000);
                                    break;
                                }
                            }
                        }
                        $ticket['status'] = $status;
                        $ticket['fixed_in'] = version_label($labels, 'fixed in ');
                        $ticket['reply'] = $reply;
                        db()->prepare('UPDATE zs_tickets SET status = ?, fixed_in = ?, reply = ?, checked = ? WHERE id = ?')
                            ->execute([$status, $ticket['fixed_in'], $reply, time(), $id]);
                    } catch (Throwable) {
                        // The last known status is answered.
                    }
                }
                $out[] = ['id' => $id, 'status' => $ticket['status'], 'fixedIn' => $ticket['fixed_in'], 'reply' => $ticket['reply']];
            }
            answer(200, ['ok' => true, 'tickets' => $out]);

        case 'GET ideas':
            $install = install_of($_GET['install'] ?? null);
            limit('ideas', $ip, 240, 3600);
            $who = hash_of($install);
            $approval = settings()['ideas_need_approval'] ? ' AND (approved = 1 OR install_hash = :who2)' : '';
            $list = db()->prepare("SELECT i.*, (SELECT COUNT(*) FROM zs_votes v WHERE v.idea_id = i.id AND v.install_hash = :who) AS voted
                FROM zs_ideas i WHERE hidden = 0$approval ORDER BY votes DESC, created DESC LIMIT 300");
            $params = [':who' => $who];
            if ($approval) $params[':who2'] = $who;
            $list->execute($params);
            $ideas = array_map(fn($idea) => [
                'id' => $idea['id'],
                'title' => $idea['title'],
                'body' => $idea['body'],
                'votes' => (int) $idea['votes'],
                'status' => $idea['status'],
                'voted' => (int) $idea['voted'] > 0,
                'mine' => hash_equals($idea['install_hash'], $who),
                'created' => (int) $idea['created'] * 1000,
                'shippedIn' => $idea['shipped_in'],
            ], $list->fetchAll());
            $last = db()->query("SELECT until_at FROM zs_hits WHERE bucket = 'sync'")->fetchColumn();
            $syncDue = github_ready() && (!$last || (int) $last < time());
            if ($syncDue) {
                db()->prepare('DELETE FROM zs_hits WHERE bucket = ?')->execute(['sync']);
                db()->prepare('INSERT INTO zs_hits (bucket, hits, until_at) VALUES (?, 1, ?)')->execute(['sync', time() + 900]);
            }
            if ($syncDue && function_exists('fastcgi_finish_request')) {
                echo json_encode(['ok' => true, 'ideas' => $ideas], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                fastcgi_finish_request();
                try {
                    sync();
                } catch (Throwable) {
                }
                exit;
            }
            answer(200, ['ok' => true, 'ideas' => $ideas]);

        case 'POST idea':
            $install = install_of($input['install'] ?? null);
            limit('idea', $install, 5, 86400);
            limit('idea-ip', $ip, 20, 86400);
            $title = text_of($input['title'] ?? '', 120, 4);
            $body = text_of($input['body'] ?? '', 1000);
            if (preg_match('#(https?://|www\.)#i', "$title $body")) throw new Fail(400, 'links');
            $lang = in_array($input['lang'] ?? '', ['ar', 'en'], true) ? $input['lang'] : 'ar';
            $idea = ['id' => new_id(), 'title' => $title, 'body' => $body, 'lang' => $lang, 'votes' => 1];
            $who = hash_of($install);
            $pdo = db();
            $pdo->beginTransaction();
            $pdo->prepare('INSERT INTO zs_ideas (id, title, body, lang, install_hash, created, votes) VALUES (?, ?, ?, ?, ?, ?, 1)')
                ->execute([$idea['id'], $title, $body, $lang, $who, time()]);
            $pdo->prepare('INSERT INTO zs_votes (idea_id, install_hash, created) VALUES (?, ?, ?)')->execute([$idea['id'], $who, time()]);
            $pdo->commit();
            if (github_ready()) {
                try {
                    $number = file_idea($idea);
                    $pdo->prepare('UPDATE zs_ideas SET issue_number = ?, synced_votes = votes WHERE id = ?')->execute([$number, $idea['id']]);
                } catch (Throwable) {
                }
            }
            answer(200, ['ok' => true, 'idea' => [
                'id' => $idea['id'], 'title' => $title, 'body' => $body, 'votes' => 1, 'status' => 'open',
                'voted' => true, 'mine' => true, 'created' => time() * 1000, 'shippedIn' => null,
            ]]);

        case 'POST vote':
            $install = install_of($input['install'] ?? null);
            limit('vote', $install, 200, 3600);
            limit('vote-ip', $ip, 600, 3600);
            $id = (string) ($input['idea'] ?? '');
            if (!preg_match('/^[0-9a-f]{16}$/', $id)) throw new Fail(400, 'idea');
            $on = ($input['on'] ?? false) === true;
            // A few votes for one idea from one address a day (a home, an office), not hundreds from new install ids.
            if ($on) limit('vote-idea-ip', "$ip:$id", 5, 86400);
            $who = hash_of($install);
            $pdo = db();
            $found = $pdo->prepare('SELECT id FROM zs_ideas WHERE id = ? AND hidden = 0');
            $found->execute([$id]);
            if (!$found->fetch()) throw new Fail(404, 'no such idea');
            $pdo->beginTransaction();
            $had = $pdo->prepare('SELECT 1 FROM zs_votes WHERE idea_id = ? AND install_hash = ?');
            $had->execute([$id, $who]);
            $voted = (bool) $had->fetchColumn();
            if ($on && !$voted) {
                $pdo->prepare('INSERT INTO zs_votes (idea_id, install_hash, created) VALUES (?, ?, ?)')->execute([$id, $who, time()]);
            } elseif (!$on && $voted) {
                $pdo->prepare('DELETE FROM zs_votes WHERE idea_id = ? AND install_hash = ?')->execute([$id, $who]);
            }
            $count = $pdo->prepare('SELECT COUNT(*) FROM zs_votes WHERE idea_id = ?');
            $count->execute([$id]);
            $votes = (int) $count->fetchColumn();
            $pdo->prepare('UPDATE zs_ideas SET votes = ? WHERE id = ?')->execute([$votes, $id]);
            $pdo->commit();
            answer(200, ['ok' => true, 'votes' => $votes]);
    }
    throw new Fail(404, 'unknown');
} catch (Fail $fail) {
    answer($fail->status, ['ok' => false, 'error' => $fail->getMessage()]);
} catch (Throwable $error) {
    error_log('zood support relay: ' . $error->getMessage());
    answer(500, ['ok' => false, 'error' => 'server']);
}
