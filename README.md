# Atlas Money

A simple, private money manager that runs entirely in your browser. You can record your daily income and expenses, sort them into categories, and see reports on where your money goes.

Your data is **end-to-end encrypted** and synced through your own [Supabase](https://supabase.com) project, so you can use Atlas on any device. Nothing is kept in the browser. Statements are read on your device and never uploaded as files; only the encrypted data is saved. There's no build step.

## Features

- **Record transactions**: amount, date, expense or income, category, payment method, description and notes. You can edit or delete any entry.
- **Bank accounts**: add bank, savings, credit card, cash and wallet accounts with a starting balance. Every transaction can be recorded against an account, and **transfers** move money between accounts (e.g. an ATM withdrawal or a credit-card bill payment) without counting as income or spending. The **Accounts** tab shows each account's current balance, this month's money in and out, and your net worth. You can archive old accounts to hide them while keeping their history. Transactions recorded before you added accounts can be assigned to one in bulk.
- **Statements**: pick an account and a period to see the opening balance, every credit and debit with a running balance, totals, and the closing balance. Export a statement to CSV, or use Print / PDF.
- **Bulk add accounts**: **Accounts → Add several** lets you enter many accounts at once in a table.
- **Import bank statements** (**Import** tab): upload statements as CSV, Excel (XLS/XLSX/ODS), OFX/QFX or PDF. You can upload several files for the same account at once.
  - Atlas finds the header row and detects the date, description, money in/out (or a signed amount with a Dr/Cr marker) and balance columns. It works out whether dates are day-first or month-first and handles formats like `1,23,456.78`, `(45.00)` and `500.00 Dr`. You can correct any column choice, and a live preview updates as you do.
  - PDF statements are read in the browser (password-protected PDFs are supported). The running balance is used to tell money in from money out. Rows Atlas isn't sure about are flagged so you can swap them with ⇄. Scanned (image-only) PDFs can't be read; download a CSV or Excel copy instead.
  - Rows already imported (including from overlapping statements) are skipped. Rows matching something you entered by hand are flagged as possible duplicates.
  - If the statement shows a running balance, Atlas can set the account's starting balance so its balance matches the statement.
  - Imported transactions keep the bank's own text, but the description and category are left empty for you to fill in.
- **Review list**: every imported transaction waits in **Import → Review** until you add a description and a category. Press Enter to save a row and jump to the next one, tick several rows to give them a category at once, or mark a row as a transfer between your accounts. When the other account's statement has the matching entry, the two are merged, so it isn't counted twice.
- **Categories**: comes with sensible defaults for expenses and income. You can add, rename (existing transactions update too) or remove categories in **Settings**.
- **Dashboard**: this month's spending, earnings, net savings and change vs. last month. It also shows an optional monthly budget meter, top categories and recent transactions.
- **Transactions**: search and filter by date range, type and category, with running totals for the filtered set.
- **Reports**: for this month, last month, the last 3 months, this year, the last 12 months, all time or a custom range:
  - totals, savings rate and average spend per day
  - spending by category, as a chart and a table with shares
  - monthly income vs. expenses
  - daily spending, or average spend by weekday for longer periods
  - spending by payment method
  - largest expenses
- **Data**: export to CSV or a JSON backup. Import a JSON backup (replaces your data) or a CSV (adds to your data, needs at least `date` and `amount` columns; `type`, `account`, `to_account`, `category`, `description`, `method` and `notes` are optional, and accounts named in the CSV are created if they don't exist). Use the JSON backup to move everything, including account types and starting balances. You can also load sample data to try the app out.
- Choice of currency, light and dark mode, and a mobile-friendly layout.

## Security model

- **One password, two keys.** Your password never leaves your device. PBKDF2-SHA256 (600,000 rounds, salted with your email) turns it into 512 bits. The first half is an AES-256-GCM key that encrypts all your data. The second half is the only "password" Supabase ever sees. Supabase can't work back from it to the encryption key, so it only ever stores ciphertext.
- **Nothing in the browser.** Decrypted data exists only in the open tab's memory. Closing the tab, reloading, pressing **Lock**, signing out, or 30 minutes without activity wipes it. Each time, you sign in again with your password.
- **Row-level security** (`supabase/schema.sql`) means each account can only read or write its own encrypted row.
- **Multiple devices**: saves use a version number. If two devices save at once, the changes are merged item by item and nothing is overwritten.
- **Content Security Policy**: the page may only connect to Supabase and load scripts from itself and cdnjs, which limits where any injected code could send data.
- **No password reset.** Because only your password can decrypt your data, a forgotten password means the data is gone. Keep the password in a password manager, and keep an occasional **Export backup** somewhere private. Exports are *not* encrypted, so never commit them to this repository.

## Cloud storage setup

1. Create a free account at [supabase.com](https://supabase.com) and a **New project**. Pick a region near you and any database password; Atlas doesn't use it.
2. Open **SQL Editor → New query**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
3. Go to **Authentication → URL Configuration** and set **Site URL** to the address of your site, e.g. `https://pratap-01.github.io/Atlas/`. The sign-up confirmation email links there.
4. Go to **Project Settings → API Keys** and copy the **Project URL** and the **anon / publishable** key into `js/config.js`. Both are safe to publish: row-level security limits that key to each user's own encrypted row. **Never** use the `service_role` / secret key.
5. Optional: in `index.html`, narrow `connect-src https://*.supabase.co` in the Content-Security-Policy to your exact project URL.
6. Open the site, click **Create an account**, confirm your email, and sign in. If this browser has data from an older version of Atlas, you'll be offered to move it into the encrypted storage. It's then removed from the browser.

## Running it

Atlas needs to be served over http(s) to talk to Supabase. Serve the folder locally:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

To use it on your phone, host the folder on any static host, such as GitHub Pages.

## Project layout

```
index.html        UI markup (Dashboard, Transactions, Reports, Settings)
css/styles.css    Styles, including dark mode
js/config.js      Supabase project URL + public (anon) key
js/cloud.js       Sign-in, end-to-end encryption, multi-device sync
js/storage.js     In-memory data model
js/importer.js    Statement parsing (CSV, Excel, OFX, PDF), column detection
js/charts.js      Small SVG chart helpers (bars and columns with hover tooltips)
js/app.js         App logic: forms, filters, reports, import and export
supabase/schema.sql  Database table + row-level security policies
```
