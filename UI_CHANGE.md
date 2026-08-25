# UI Change Verification Rules

Use these rules whenever a user asks for a browser UI change.

## Do not report success without browser evidence

Code changes and source-based tests are not proof that the browser changed. Do not say a UI task is complete until the changed page has been opened or inspected in a real browser at the requested viewport, and the result is visibly confirmed.

If browser inspection is unavailable, say that clearly. Do not claim the visual result is fixed; report only that the code and tests were updated.

## Required workflow

1. Identify the exact page, visible problem, and expected result from the user's screenshot or description.
2. Make the smallest change that addresses the problem.
3. Reload the affected page in the running application using a hard refresh. If static files may be cached, use a cache-busting URL or restart the local server when appropriate.
4. Inspect the browser at the same viewport size as the screenshot, and also at a narrow viewport if the change is responsive.
5. Compare the live result with the requested result before reporting completion.

## If the browser shows no change

Do not keep guessing. Diagnose in this order:

1. Verify the browser is connected to the workspace server and correct port, not a different running copy of the app.
2. Verify the changed CSS or JavaScript file is loaded by the browser, then hard refresh with cache disabled if needed.
3. Check CSS precedence in browser developer tools: computed styles, selector specificity, inline styles, and rules defined later in the stylesheet.
4. Check whether dynamically rendered markup overwrites the changed element after page load.
5. Check the real element dimensions and overflow rules; do not infer layout from source code alone.
6. Make one targeted correction, refresh, and inspect again.

## Completion standard

Report these separately:

- **Browser verified:** the visible result was inspected and matches the request.
- **Code verified only:** tests passed, but browser verification was unavailable.

Never label a UI change as browser verified when only source tests passed.
