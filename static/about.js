// /about: reveal-on-scroll + a live/paused status chip. Data: /api/about?kind=transparency
(() => {
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el, i) => { el.style.transitionDelay = (i % 3) * 80 + "ms"; io.observe(el); });
  const s = document.getElementById("t-state");
  fetch("/api/about?kind=transparency").then(r => r.json()).then(d => { s.textContent = d.painting ? "Live" : "Replay"; })
    .catch(() => { s.textContent = "Live"; });
})();
