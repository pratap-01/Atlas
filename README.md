# Atlas Money

A simple, private money manager that runs entirely in your browser. You can record your daily income and expenses, sort them into categories, and see reports on where your money goes.

No server, no sign-up and no dependencies. Your data is saved in the browser's `localStorage`.

## Features

- **Record transactions**: amount, date, expense or income, category, payment method, description and notes. You can edit or delete any entry.
- **Bank accounts**: add bank, savings, credit card, cash and wallet accounts with a starting balance. Every transaction can be recorded against an account, and **transfers** move money between accounts (e.g. an ATM withdrawal or a credit-card bill payment) without counting as income or spending. The **Accounts** tab shows each account's current balance, this month's money in and out, and your net worth. You can archive old accounts to hide them while keeping their history. Transactions recorded before you added accounts can be assigned to one in bulk.
- **Statements**: pick an account and a period to see the opening balance, every credit and debit with a running balance, totals, and the closing balance. Export a statement to CSV, or use Print / PDF.
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

## Running it

Open `index.html` in a browser. Or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

To use it on your phone, host the folder on any static host, such as GitHub Pages.

> Data is stored per browser and per device. Use **Settings → Export backup** regularly and **Import** to move your data between devices.

## Project layout

```
index.html        UI markup (Dashboard, Transactions, Reports, Settings)
css/styles.css    Styles, including dark mode
js/storage.js     localStorage persistence and data model
js/charts.js      Small SVG chart helpers (bars and columns with hover tooltips)
js/app.js         App logic: forms, filters, reports, import and export
```
