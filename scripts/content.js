// content.js
// ──────────────────────────────────────────────────────────────
// 백준 문제 페이지(acmicpc.net/problem/{번호})에서 실행되는 Content Script
// pendingCrawls에 등록된 문제만 크롤링한다. (On-Demand 방식)
// ──────────────────────────────────────────────────────────────
(function () {
  // /problem/{숫자} 형태가 아니면 무시
  if (!/\/problem\/\d+/.test(location.pathname)) return;

  const problemNum = Number(location.pathname.split("/").pop());

  // pendingCrawls에 현재 문제가 있는지 확인
  chrome.storage.local.get("pendingCrawls", ({ pendingCrawls }) => {
    const pending = pendingCrawls || [];
    if (!pending.includes(problemNum)) {
      console.log(`[UJAX] 스킵: ${problemNum}번 (요청된 크롤링 아님)`);
      return;
    }

    const $ = (sel) => document.querySelector(sel);
    const html = (el) => (el ? el.innerHTML.trim() : "");
    const txt = (el) => (el ? el.innerText.trim() : "");
    const DANGEROUS_TAG_SELECTOR = [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "style",
      "link",
      "meta",
      "base",
      "template",
    ].join(",");

    function sanitizeProblemHtml(rawHtml) {
      if (!rawHtml) return "";
      const container = document.createElement("div");
      container.innerHTML = rawHtml;

      container.querySelectorAll(DANGEROUS_TAG_SELECTOR).forEach((el) => el.remove());

      container.querySelectorAll("*").forEach((el) => {
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          const value = String(attr.value || "").trim().toLowerCase();

          if (name.startsWith("on") || name === "style") {
            el.removeAttribute(attr.name);
            continue;
          }

          if (
            (name === "src" || name === "href" || name === "xlink:href" || name === "formaction") &&
            (value.startsWith("javascript:") || value.startsWith("data:"))
          ) {
            el.removeAttribute(attr.name);
          }
        }
      });

      return container.innerHTML;
    }

    const title = txt($("#problem_title"));

    // 문제 페이지가 존재하지 않으면 빈 데이터를 보내서 background가 탭을 닫도록 함
    if (!title) {
      const updated = pending.filter((n) => n !== problemNum);
      chrome.storage.local.set({ pendingCrawls: updated });
      chrome.runtime.sendMessage({ type: "problemData", data: { problemNum, title: "" } });
      console.warn(`[UJAX] 크롤링 실패: ${problemNum}번 문제를 찾을 수 없음`);
      return;
    }

    const description = sanitizeProblemHtml(html($("#problem_description")));
    const inputDescription = sanitizeProblemHtml(html($("#problem_input")));
    const outputDescription = sanitizeProblemHtml(html($("#problem_output")));

    // 시간/메모리 제한 — #problem-info 테이블에서 추출
    let timeLimit = "";
    let memoryLimit = "";
    const infoTable = $("#problem-info");
    if (infoTable) {
      const ths = [...infoTable.querySelectorAll("thead th")].map((th) => th.textContent.trim());
      const tds = [...infoTable.querySelectorAll("tbody tr:first-child td")].map((td) => td.textContent.trim());
      const findVal = (regex) => {
        const idx = ths.findIndex((h) => regex.test(h));
        return idx >= 0 ? tds[idx] : "";
      };
      timeLimit = findVal(/시간\s*제한|Time/i);
      memoryLimit = findVal(/메모리\s*제한|Memory/i);
    }

    // 입출력 예제 (최대 20개)
    const samples = [];
    for (let i = 1; i <= 20; i++) {
      const inputEl = document.getElementById(`sample-input-${i}`);
      const outputEl = document.getElementById(`sample-output-${i}`);
      if (!inputEl && !outputEl) break;
      samples.push({
        sampleIndex: i,
        input: (inputEl?.textContent || "").replace(/\s+$/, ""),
        output: (outputEl?.textContent || "").replace(/\s+$/, ""),
      });
    }

    // 문제 태그 (페이지에 노출된 경우)
    const tagEls = document.querySelectorAll(".problem-tag a, .problem-label-tag a");
    const tags = [...tagEls].map((a) => a.textContent.trim()).filter(Boolean);

    const payload = {
      problemNum,
      title,
      url: location.href,
      timeLimit,
      memoryLimit,
      description,
      inputDescription,
      outputDescription,
      samples,
      tags,
    };

    // pendingCrawls에서 현재 문제 제거
    const updated = pending.filter((n) => n !== problemNum);
    chrome.storage.local.set({ pendingCrawls: updated });

    chrome.runtime.sendMessage({ type: "problemData", data: payload });
    console.log("[UJAX] 문제 데이터 전송:", problemNum, title);
  });
})();
