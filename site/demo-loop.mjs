// The poster and GIF link work without JavaScript or video playback.
export function attachDemoLoop(player, {
  motion = window.matchMedia('(prefers-reduced-motion: reduce)'),
  saveData = navigator.connection?.saveData,
  Observer = window.IntersectionObserver,
} = {}) {
  const video = player.querySelector('video');
  const url = video?.dataset.loopSrc;
  const poster = player.querySelector('[data-loop-poster]');
  const button = player.querySelector('[data-loop-toggle]');
  const status = player.querySelector('[data-loop-status]');
  if (!video || !url || !poster || !button || !status) return;
  let attempt = 0, pending = false, wantsPlayback = false, timer, observer;
  const label = playing => { button.textContent = playing ? button.dataset.pause : button.dataset.play; };
  const stop = (failed = false) => {
    attempt++;
    wantsPlayback = false;
    pending = false;
    clearTimeout(timer);
    video.pause();
    label(false);
    if (failed || video.currentTime === 0) {
      video.hidden = true;
      poster.hidden = false;
    }
    if (failed) status.textContent = status.dataset.unavailable;
  };
  const start = async () => {
    observer?.disconnect();
    const token = ++attempt;
    pending = true;
    wantsPlayback = true;
    label(true);
    video.muted = true;
    video.hidden = false;
    poster.hidden = true;
    status.textContent = '';
    if (!video.getAttribute('src') || video.error) {
      video.src = url;
      video.load();
    }
    clearTimeout(timer);
    timer = setTimeout(() => { if (token === attempt) stop(true); }, 8000);
    try {
      await video.play();
      if (token !== attempt) {
        if (!wantsPlayback) video.pause();
        return;
      }
      pending = false;
      clearTimeout(timer);
    } catch {
      if (token === attempt) stop(true);
    }
  };
  button.hidden = false;
  label(false);
  button.addEventListener('click', () => {
    observer?.disconnect();
    if (pending || !video.paused) stop();
    else void start();
  });
  video.addEventListener('playing', () => {
    if (!wantsPlayback) { video.pause(); return; }
    clearTimeout(timer);
    video.hidden = false;
    poster.hidden = true;
    status.textContent = '';
    label(true);
  });
  video.addEventListener('pause', () => label(false));
  video.addEventListener('error', () => stop(true));
  motion.addEventListener('change', event => {
    if (event.matches) { observer?.disconnect(); stop(); }
  });
  if (!motion.matches && !saveData) {
    if (Observer) {
      observer = new Observer(entries => {
        if (entries.some(entry => entry.isIntersecting)) void start();
      }, {threshold: 0.2});
      observer.observe(player);
    } else void start();
  }
}

if (typeof document !== 'undefined') {
  for (const player of document.querySelectorAll('[data-demo-loop]')) attachDemoLoop(player);
}
