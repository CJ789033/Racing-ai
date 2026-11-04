// Guided tour: a card explains one part of the screen at a time, with that
// part spot-lit. Steps can require the editor or the race to be showing.

export class Tutorial {
  /**
   * @param steps [{ mode: 'editor'|'race'|null, target: selector|null, title, text, phoneText?, next? }]
   * @param hooks { ensureMode(mode), onEnd(completed) }
   */
  constructor(steps, hooks) {
    this.steps = steps;
    this.hooks = hooks;
    this.i = -1;
    const root = this.root = document.createElement('div');
    root.className = 'tutorial hidden';
    root.innerHTML = `
      <div class="tutBlock"></div>
      <div class="tutSpot"></div>
      <div class="tutCard card" role="dialog" aria-live="polite">
        <div class="tutStep muted small"></div>
        <div class="tutTitle"></div>
        <div class="tutText small"></div>
        <div class="tutButtons">
          <button class="tutSkip">Skip tutorial</button>
          <span class="tutGap"></span>
          <button class="tutBack">Back</button>
          <button class="tutNext primary">Next</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    this.spot = root.querySelector('.tutSpot');
    this.card = root.querySelector('.tutCard');
    root.querySelector('.tutSkip').onclick = () => this.end(false);
    root.querySelector('.tutBack').onclick = () => this.go(this.i - 1);
    root.querySelector('.tutNext').onclick = () => {
      const s = this.steps[this.i];
      if (s.next) s.next();
      if (this.i >= this.steps.length - 1) this.end(true); else this.go(this.i + 1);
    };
    window.addEventListener('resize', () => this.place());
    window.addEventListener('keydown', e => {
      if (!this.active) return;
      if (e.key === 'Escape') this.end(false);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') root.querySelector('.tutNext').click();
      else if (e.key === 'ArrowLeft' && this.i > 0) this.go(this.i - 1);
    });
  }

  get active() { return this.i >= 0; }

  start() { this.root.classList.remove('hidden'); this.go(0); }

  go(i) {
    if (i < 0 || i >= this.steps.length) return;
    this.i = i;
    const s = this.steps[i];
    if (s.mode) this.hooks.ensureMode(s.mode);
    const phone = matchMedia('(pointer: coarse)').matches;
    this.card.querySelector('.tutStep').textContent = `Step ${i + 1} of ${this.steps.length}`;
    this.card.querySelector('.tutTitle').textContent = s.title;
    this.card.querySelector('.tutText').innerHTML = (phone && s.phoneText) || s.text;
    this.card.querySelector('.tutBack').disabled = i === 0;
    this.card.querySelector('.tutNext').textContent = i === this.steps.length - 1 ? 'Let’s go!' : s.nextLabel || 'Next';
    // place now, and again once a mode switch has laid itself out
    this.place();
    requestAnimationFrame(() => requestAnimationFrame(() => this.place()));
    setTimeout(() => this.place(), 300);
  }

  place() {
    if (!this.active) return;
    const s = this.steps[this.i];
    // target: a CSS selector, or a function returning a screen rectangle
    let r = null;
    if (typeof s.target === 'function') r = s.target();
    else if (s.target) {
      const el = [...document.querySelectorAll(s.target)].find(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
      if (el) r = el.getBoundingClientRect();
    }
    const vw = window.innerWidth, vh = window.innerHeight, M = 12;
    const card = this.card;
    card.style.left = card.style.top = '0px';
    const cw = Math.min(360, vw - 2 * M);
    card.style.width = cw + 'px';
    const ch = card.offsetHeight;
    if (!r || !r.width) {
      this.spot.style.display = 'none';
      this.root.classList.add('dim');
      card.style.left = (vw - cw) / 2 + 'px';
      card.style.top = Math.max(M, (vh - ch) / 2) + 'px';
      return;
    }
    this.root.classList.remove('dim');
    const pad = 6;
    const sx = Math.max(2, r.left - pad), sy = Math.max(2, r.top - pad);
    const sw = Math.min(vw - 4, r.right + pad) - sx, sh = Math.min(vh - 4, r.bottom + pad) - sy;
    Object.assign(this.spot.style, { display: 'block', left: sx + 'px', top: sy + 'px', width: sw + 'px', height: sh + 'px' });
    // card: below the target if it fits, else above, else beside / over it
    let top;
    if (sy + sh + M + ch <= vh - M) top = sy + sh + M;
    else if (sy - M - ch >= M) top = sy - M - ch;
    else top = Math.max(M, Math.min(vh - ch - M, vh / 2 - ch / 2));
    let left = r.left + r.width / 2 - cw / 2;
    if (top > sy - ch && top < sy + sh && r.width < vw - cw - 3 * M) {
      // overlapping vertically: put it to the side with more room
      left = r.left > vw - r.right ? sx - cw - M : sx + sw + M;
    }
    card.style.left = Math.max(M, Math.min(vw - cw - M, left)) + 'px';
    card.style.top = top + 'px';
  }

  end(completed) {
    if (!this.active) return;
    this.i = -1;
    this.root.classList.add('hidden');
    this.hooks.onEnd(completed);
  }
}
