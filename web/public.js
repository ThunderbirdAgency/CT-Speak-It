try {
  const r = await fetch("/api/public");
  if (!r.ok) throw new Error();
  const c = await r.json();
  for (const platform of ["mac", "windows"]) {
    const a = document.getElementById("download-" + platform);
    if (a && c.downloads[platform]) {
      a.href = c.downloads[platform];
      a.textContent =
        platform === "mac" ? "Download for Mac ↗" : "Download for Windows ↗";
      a.removeAttribute("aria-disabled");
    }
  }
  const help = document.getElementById("support");
  if (
    help &&
    c.supportEmail &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.supportEmail)
  ) {
    help.href = "mailto:" + c.supportEmail;
    help.textContent = "Email Mockingbird support";
  }
} catch {}
