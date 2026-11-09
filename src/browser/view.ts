const CSS = `:host{font-family:system-ui,sans-serif;color:#172b4d}*{box-sizing:border-box}.layer{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:transparent}.layer.card{background:#fff}.panel{max-width:460px;margin:24px;padding:32px;border:1px solid #d8dfe8;border-radius:12px;background:#fff}.pending .panel{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}h2{font-size:22px;line-height:1.3;margin:0 0 12px}p{font-size:16px;line-height:1.5}button{font:inherit;padding:10px 18px;border:0;border-radius:6px;background:#172b4d;color:#fff;cursor:pointer}button:focus-visible{outline:3px solid #3899ec;outline-offset:3px}.inline{padding:16px;border:1px solid #d8dfe8;border-radius:8px}`;

export class AccessView {
  readonly element: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly layer: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly message: HTMLParagraphElement;
  private readonly retry: HTMLButtonElement;
  private readonly observer: MutationObserver;

  constructor(private readonly pageLock: boolean, container: HTMLElement | undefined, retry: () => void) {
    this.element = document.createElement('div');
    this.element.dataset.hideguardRoot = 'true';
    this.root = this.element.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = CSS;
    this.layer = document.createElement('div');
    const panel = document.createElement('div'); panel.className = 'panel'; panel.setAttribute('role', 'status'); panel.setAttribute('aria-live', 'polite');
    this.title = document.createElement('h2');
    this.message = document.createElement('p');
    this.retry = document.createElement('button'); this.retry.type = 'button'; this.retry.textContent = 'Try again';
    this.retry.addEventListener('click', retry);
    panel.append(this.title, this.message, this.retry); this.layer.append(panel); this.root.append(style, this.layer);
    (container ?? document.body).append(this.element);
    this.observer = new MutationObserver(() => this.lock());
  }

  private lock(): void {
    if (!this.pageLock || this.element.hidden) return;
    for (const child of document.body.children) {
      if (!(child instanceof HTMLElement) || child === this.element || child.hasAttribute('data-hideguard-root') || child.inert) continue;
      child.dataset.hideguardInert = 'true'; child.inert = true;
    }
  }

  show(status: 'pending' | 'blocked' | 'error', message = ''): void {
    this.element.hidden = false;
    this.layer.className = this.pageLock ? `layer ${status === 'pending' ? 'pending' : 'card'}` : 'inline';
    this.title.textContent = status === 'pending' ? 'Verifying access' : status === 'blocked' ? 'Access is blocked' : 'Verification could not be completed';
    this.message.textContent = message || 'Please wait while we verify your browser.';
    this.retry.hidden = status !== 'error';
    this.lock();
    if (this.pageLock) this.observer.observe(document.body, { childList: true });
  }

  hide(): void {
    this.element.hidden = true; this.observer.disconnect();
    if (this.pageLock) for (const child of document.querySelectorAll<HTMLElement>('[data-hideguard-inert]')) {
      child.inert = false; delete child.dataset.hideguardInert;
    }
  }

  destroy(): void { this.hide(); this.element.remove(); }
}
