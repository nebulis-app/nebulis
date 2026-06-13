# Resetting a forgotten password

Nebulis has no "forgot password" link in the web interface. That is deliberate:
anyone who could reach the web page could use it to take over the account. Resets
are done from the computer that runs the Nebulis server, by running the Nebulis
program with a recovery flag. You need to be signed in to that machine (or able
to run a terminal on it).

The reset edits the local database directly. It does not need an internet
connection and never touches Cloudflare or your account elsewhere.

## Before you start

It is cleanest to stop the Nebulis service first, so nothing else is using the
database while you reset it.

- **Windows**: right-click the Nebulis icon in the system tray and choose
  "Stop Service" (or open Services, find "Nebulis", and stop it).
- **macOS**: click the Nebulis icon in the menu bar and choose "Stop Service".

You can also reset without stopping it; the tool waits briefly for the database
to be free. Restart the service the same way when you are done.

## See which accounts exist

If you are not sure of the exact username, list the accounts first.

**Windows** (open Command Prompt):
```
"C:\Program Files\Nebulis\nebulis.exe" --list-users
```

**macOS** (open Terminal):
```
/Applications/Nebulis.app/Contents/Helpers/nebulis --list-users
```

**Docker**:
```
docker compose -f docker/docker-compose.yml exec nebulis npx tsx server/index.ts --list-users
```

It prints each account's username and role, for example:
```
  Accounts:
    - brent  (admin)  "Brent"
```

## Reset the password

Replace `<username>` with the account name from the list.

**Windows**:
```
"C:\Program Files\Nebulis\nebulis.exe" --reset-password <username>
```

**macOS**:
```
/Applications/Nebulis.app/Contents/Helpers/nebulis --reset-password <username>
```

**Docker**:
```
docker compose -f docker/docker-compose.yml exec nebulis npx tsx server/index.ts --reset-password <username>
```

The tool prints a new randomly generated password:
```
  Password reset for "brent" (admin).

    New password:  6lPRf6CQdCFW

  Log in with that, then change it under Settings.
```

Sign in with that password, then set a password you will remember under
Settings -> Account.

### Setting a specific password instead

Add the password you want as a second value:
```
"C:\Program Files\Nebulis\nebulis.exe" --reset-password <username> MyNewPassw0rd
```

## If it says "No database found"

The tool looks for the database in the standard location:

- Windows: `C:\ProgramData\Nebulis\data\nebulis.db`
- macOS: `~/Library/Application Support/Nebulis/nebulis.db`
- Docker: `/app/data/nebulis.db`

If you moved your data elsewhere, point the tool at it with `DATA_DIR`:

**Windows** (Command Prompt):
```
set DATA_DIR=D:\NebulisData
"C:\Program Files\Nebulis\nebulis.exe" --reset-password <username>
```

**macOS** (Terminal):
```
DATA_DIR="/path/to/your/data" /Applications/Nebulis.app/Contents/Helpers/nebulis --reset-password <username>
```

## If no accounts exist

If `--list-users` shows no accounts, the database has none yet. Just open the web
interface; with no accounts, Nebulis lets you in to create the first one.
