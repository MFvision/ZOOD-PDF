<?php
// ZOOD PDF support relay: the cron job. In hPanel › Advanced › Cron Jobs, run
//   php /home/<you>/public_html/api/support/sync.php
// every 15 minutes. It files anything GitHub refused earlier, writes vote
// counts onto the idea issues, and brings your GitHub labels back.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/lib.php';
echo json_encode(sync(240)), "\n";
