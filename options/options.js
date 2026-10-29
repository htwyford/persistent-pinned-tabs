"use strict";

const list = document.getElementById("pins");
const empty = document.getElementById("empty");

async function render() {
  const { pins = [], closeBehavior = "reset" } = await browser.storage.local.get([
    "pins",
    "closeBehavior",
  ]);

  for (const radio of document.querySelectorAll("input[name=closeBehavior]")) {
    radio.checked = radio.value === closeBehavior;
  }

  list.replaceChildren(
    ...pins.map((pin) => {
      const li = document.createElement("li");
      const text = document.createElement("div");
      text.className = "text";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = pin.title || pin.url;
      const url = document.createElement("div");
      url.className = "url";
      url.textContent = pin.url;
      text.append(title, url);
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.addEventListener("click", () =>
        browser.runtime.sendMessage({ type: "remove-pin", id: pin.id })
      );
      li.append(text, remove);
      return li;
    })
  );
  empty.hidden = pins.length > 0;
}

document.addEventListener("change", (e) => {
  if (e.target.name === "closeBehavior") {
    browser.storage.local.set({ closeBehavior: e.target.value });
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local") render();
});

render();
