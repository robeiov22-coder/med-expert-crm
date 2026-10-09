# Gmail-синхронізація результатів аналізів

Модуль підключає три робочі скриньки до CRM через Gmail OAuth і шукає тільки листи від `mail@nikolab.com.ua` з PDF-вкладеннями за останні 30 днів.

## Розгортання

Потрібні Firebase CLI, активний проєкт Firebase та план, який підтримує Cloud Functions і Cloud Storage. Секрети не зберігаються в репозиторії:

```powershell
firebase login
firebase use gen-lang-client-0271662985
firebase functions:secrets:set GMAIL_CLIENT_ID
firebase functions:secrets:set GMAIL_CLIENT_SECRET
firebase functions:secrets:set GMAIL_REDIRECT_URI
firebase deploy --only functions
```

Для `GMAIL_REDIRECT_URI` використайте:
`https://us-central1-gen-lang-client-0271662985.cloudfunctions.net/gmailOAuthCallback`

Після розгортання один раз відкрийте в браузері для кожної скриньки:

```text
https://us-central1-gen-lang-client-0271662985.cloudfunctions.net/gmailOAuthStart?mailbox=polyclinic.chernigiv.l@gmail.com
https://us-central1-gen-lang-client-0271662985.cloudfunctions.net/gmailOAuthStart?mailbox=polyclinic.chernigiv@gmail.com
https://us-central1-gen-lang-client-0271662985.cloudfunctions.net/gmailOAuthStart?mailbox=polyclinic.snovsk@gmail.com
```

Після дозволу Gmail токени зберігаються в захищеній колекції Firestore. Для імпорту викликається POST:

```text
https://us-central1-gen-lang-client-0271662985.cloudfunctions.net/gmailSync
```

з JSON `{ "mailbox": "polyclinic.chernigiv.l@gmail.com" }`.

PDF зберігається у Cloud Storage, а в Firestore записується результат імпорту, текст PDF, пацієнт, контрагент і статус `Потребує перевірки`. Автоматичний медичний висновок не генерується без окремого підтвердженого AI-сервісу та контролю медичного працівника.

