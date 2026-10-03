// Adds a copy button to every code frame. Without JavaScript the code stays selectable and no dead button appears.
for (const frame of document.querySelectorAll(".frame")) {
  const pre = frame.querySelector("pre");
  if (!pre || !navigator.clipboard) continue;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  const word = document.createElement("span");
  word.textContent = "Copy";
  button.append(word);
  const label = frame.querySelector("figcaption");
  if (label) {
    const hidden = document.createElement("span");
    hidden.className = "visually-hidden";
    hidden.textContent = ` ${label.textContent.trim()}`;
    button.append(hidden);
  }
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.className = "visually-hidden";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.innerText.replace(/\n$/, ""));
      word.textContent = "Copied";
      button.dataset.state = "copied";
      status.textContent = "Copied to clipboard";
    } catch {
      word.textContent = "Select it";
      status.textContent = "Copy failed, select the text instead";
    }
    setTimeout(() => {
      word.textContent = "Copy";
      delete button.dataset.state;
      status.textContent = "";
    }, 1800);
  });
  frame.append(button, status);
}
