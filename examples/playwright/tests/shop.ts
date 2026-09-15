import type { Page } from '@playwright/test';

/**
 * A tiny fake shop rendered straight into the page so the demo needs no backend.
 * Real suites would navigate to their staging environment instead.
 */
export async function login(
  page: Page,
  credentials: { email: string; password: string },
): Promise<void> {
  await page.setContent(`
    <form id="login">
      <input id="email" /><input id="password" type="password" />
      <button type="submit">Sign in</button>
    </form>
    <main id="account" hidden><h1>Signed in as <span id="who"></span></h1><button id="checkout">Checkout</button><p id="status"></p></main>
    <script>
      document.getElementById('login').addEventListener('submit', (e) => {
        e.preventDefault();
        document.getElementById('who').textContent = document.getElementById('email').value;
        document.getElementById('login').hidden = true;
        document.getElementById('account').hidden = false;
      });
      document.getElementById('checkout').addEventListener('click', () => {
        document.getElementById('status').textContent = 'Order placed';
      });
    </script>`);
  await page.fill('#email', credentials.email);
  await page.fill('#password', credentials.password);
  await page.click('button[type=submit]');
}
