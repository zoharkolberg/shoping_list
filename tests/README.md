# הרצת בדיקות OAuth, CSP ו־Google Sheets

הבדיקות משתמשות ב־Node.js, ב־Playwright וב־Chromium ככלי פיתוח. הדפדפן מריץ את עמוד ה־POC דרך HTTP מקומי תחת `/shoping_list/`. הבדיקות מדמות את GIS, את UserInfo, Drive ו־Sheets עם מזהי דמה וכתובות תחת `example.test`. אין צורך בחשבון Google או ב־OAuth Client ID אמיתי.

## Codex

נבדק עם Node.js 24.22.3, Playwright 1.62.1, Chromium 156 ו־Python 3. פתחו שני טרמינלים בשורש המאגר. בטרמינל הראשון הריצו:

```sh
TEST_WEB_ROOT="$(mktemp -d)"
ln -s "$PWD" "$TEST_WEB_ROOT/shoping_list"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$TEST_WEB_ROOT"
```

בטרמינל השני הריצו:

```sh
node --check poc/app.js
node --check poc/sheets.js
node --check poc/sheets-ui.js
node --check tests/oauth.test.cjs
node --check tests/sheets.test.cjs
NODE_PATH="$(dirname "$(dirname "$(command -v node)")")/node_modules" \
  POC_CHROMIUM="$(command -v chromium)" \
  node --test tests/*.test.cjs
git diff --check
```

הפקודה מניחה ש־Playwright מותקן לצד Node.js של Codex וש־`chromium` נמצא ב־`PATH`. אם Playwright או Chromium חסרים, אפשר להשתמש ב־Node.js 24 וב־npm ולהתקין את כלי הבדיקה בתיקייה זמנית. השאירו את שרת ה־HTTP פעיל:

```sh
TEST_TOOLS="$(mktemp -d)"
npm install --prefix "$TEST_TOOLS" --no-audit --no-fund playwright@1.62.1
PLAYWRIGHT_BROWSERS_PATH="$TEST_TOOLS/browsers" \
  "$TEST_TOOLS/node_modules/.bin/playwright" install chromium
NODE_PATH="$TEST_TOOLS/node_modules" PLAYWRIGHT_BROWSERS_PATH="$TEST_TOOLS/browsers" \
  node --test tests/*.test.cjs
```

ל־Chromium דרושות גם ספריות המערכת של הדפדפן. לאחר הבדיקות אפשר לעצור את השרת עם Ctrl+C.

## גבולות האימות

תוצאות הסוויטה הן תוצאות סימולציה. תרחישי הזמן משתמשים בשעון של Playwright. עבור שימוש חי עם חשבונות הבדיקה ועם Pages, ראו את [הוראות ההרצה הידנית](../poc/README.md). אימות TLS בדפדפן נשאר פעיל.

הבדיקה הסטטית משווה את מדיניות ה־CSP להנחיות GIS עבור `script-src`, `style-src`, `frame-src` ו־`connect-src`. בדיקת Chromium מאמתת שתגית `<style>` שנוספה בזמן ריצה קובעת את גובהו של iframe מדומה, ושמאפיין `style` וסקריפט inline נחסמים. בדיקת Picker מדמה בחירת גיליון משותף וגילוי מחדש אחרי חיבור חוזר. ל־`connect-src` נוספים מקורות ה־API הדרושים ל־UserInfo, Drive ו־Sheets. `default-src 'none'` נשאר ברירת המחדל. [הנחיות Google ל־CSP](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid#content_security_policy)
