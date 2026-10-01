// "Save as PDF": renders one job's result on paper-style pages (light theme, no animation), then tells the
// main process it's ready to print (work-files.js saveAsPdf).
(async () => {
  const id = new URLSearchParams(location.search).get('job');
  const d = await window.ares.work.detail(id);
  const art = document.getElementById('result');
  if (d?.result) {
    art.innerHTML = Markdown.render(d.result, id);
    await Markdown.enhance(art, id, { theme: 'light', interactive: false });
  } else art.textContent = 'This job has no result yet.';
  document.getElementById('meta').textContent = `${d?.job?.title || ''} · ${new Date(d?.job?.finished || Date.now()).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}`;
  await new Promise((r) => setTimeout(r, 300)); // let charts finish laying out
  window.ares.work.printReady();
})();
