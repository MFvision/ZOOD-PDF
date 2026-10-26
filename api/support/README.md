# Support relay (Hostinger, PHP + MySQL)

The app's Help & Support window sends reports and ideas here, and this relay
passes them to a **private** GitHub repository. It holds no accounts and no
passwords. It also keeps no addresses: install numbers and IP addresses are
salted and hashed before they are stored. Nothing is sent to it until the
person reads what will go and presses Send.

Until it is uploaded, the app sees "can't be reached" and offers the same
report by e-mail instead, so nothing is lost.

```
index.php           the only file that answers (?a=ping|ticket|status|ideas|idea|vote)
lib.php             shared code: database, GitHub, sync
sync.php            the cron job (command line only)
config.sample.php   copy to config.php and fill in (never in git, never served)
.htaccess           serves index.php only
```

## Put it online (about 15 minutes, once)

1. **Private repository.** On GitHub, create `MFvision/zood-support` and set
   it to **Private**. Add the labels `ticket`, `idea`, `in progress`,
   `planned`, `building`, `shipped` and `hidden`. Labels that don't exist are
   created the first time they are used, so this step is optional.
2. **Token.** Go to GitHub › Settings › Developer settings › Fine-grained
   tokens › Generate new token. Under Repository access, pick **Only select
   repositories** and choose `zood-support`. Under Permissions, set
   **Issues: Read and write** and **Contents: Read and write**. Set an
   expiry date and copy the token.
3. **Database.** In hPanel, open Databases › MySQL Databases and create a
   database and a user. Write down the database name, the user and the
   password. The tables are created on the first request.
4. **Upload.** In hPanel › File Manager, open `public_html` for
   `pdf.zoodrealty.com`. Upload this folder so that it sits at
   `public_html/api/support/`, then check that
   `https://pdf.zoodrealty.com/api/support/` is the right address.
5. **Settings.** In that folder, copy `config.sample.php` to `config.php` and
   fill in the database details, `github_token`, and a long random `salt`.
6. **Cron.** In hPanel › Advanced › Cron Jobs, add a job that runs every 15
   minutes:
   `/usr/bin/php /home/<user>/domains/pdf.zoodrealty.com/public_html/api/support/sync.php`
   Without the cron job, the relay still syncs at most every 15 minutes
   after a request reaches it.
7. **Check.** Open `https://pdf.zoodrealty.com/api/support/?a=ping`. It should show
   `{"ok":true,...}`. If it shows "not set up", `config.php` is missing. In
   the app, open Help › Help & Support › Report a problem and send a test.
   An issue should appear in `zood-support`.

PHP 8.1 or newer is needed, with PDO MySQL and curl. Hostinger includes
both. The relay needs no Composer packages.

## What the labels do

**Tickets** (issues labelled `ticket`):

| On GitHub | In the app |
| --- | --- |
| open | Open |
| label `in progress` | In progress |
| closed | Fixed |
| closed with label `fixed in 0.5.1` | Fixed in 0.5.1 |
| a comment starting with `Reply:` from you | shown as the reply |

**Ideas** (issues labelled `idea`):

| On GitHub | On the board |
| --- | --- |
| label `planned` / `building` | Planned / Being built |
| label `shipped` or closed as completed | Shipped (shown last) |
| label `shipped in 0.5.1` | Shipped in 0.5.1 |
| label `hidden`, or closed as not planned | removed from the board |

Vote counts are written into each idea issue's description, and the weekly
review reads them from there. `ideas_need_approval` is on by default: a new idea shows to the person who sent it, and to everyone once you label it `approved`.

## Limits

Each install may send 5 reports an hour, 5 ideas a day and 200 votes an hour,
and each address has a higher limit on top of that. A report's text can be up
to 4,000 characters, and its picture (JPEG or PNG) up to about 1.5 MB. Ideas may not contain links, and `@` mentions are neutralised so
that no GitHub user is pinged.

## Test it locally

```
node website/tools/support-relay-check.mjs
```

This check runs the relay with PHP's built-in server, SQLite and a fake
GitHub, and covers every action, the limits and the sync.
