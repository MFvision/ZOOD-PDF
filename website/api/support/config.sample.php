<?php
// ZOOD PDF support relay: your settings. Copy this file to config.php (same
// folder) and fill it in. config.php is never served to visitors (.htaccess)
// and never goes in git.
return [
    // The MySQL database from hPanel › Databases › MySQL Databases.
    'db_dsn' => 'mysql:host=localhost;dbname=u000000000_zoodsupport;charset=utf8mb4',
    'db_user' => 'u000000000_zood',
    'db_password' => 'the database password',

    // The PRIVATE GitHub repository that receives tickets and ideas, and a
    // fine-grained token for it with "Issues: read and write" and
    // "Contents: read and write" on that repository only.
    'github_repo' => 'MFvision/zood-support',
    'github_token' => 'github_pat_…',

    // Any long random text. It turns install numbers and addresses into
    // hashes before they are stored, so the database holds neither.
    'salt' => 'change me to a long random text',

    // Which sites may call the relay. '*' lets the desktop app and the web
    // app in; the relay takes no cookies, so nothing is exposed by it.
    'allowed_origins' => ['*'],

    // New ideas show for everyone at once. Set to true to show only the ones
    // you label "approved" on GitHub.
    'ideas_need_approval' => false,
];
