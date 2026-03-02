// sourceContent.js
// ──────────────────────────────────────────────────────────────
// 백준 소스 코드 페이지(acmicpc.net/source/{id})에서 실행되는 Content Script
// 소스 코드를 추출하여 background.js로 전달한다.
// ──────────────────────────────────────────────────────────────
(function () {
  const sid = location.pathname.match(/\/source\/(\d+)/)?.[1] || "";
  if (!sid) return;

  function grabOnce() {
    // 1) textarea 또는 pre 요소에서 코드 추출
    const el = document.querySelector(
      "textarea#source, #source, pre#source, pre code, #code, #code_area pre, .source-code pre"
    );
    let code = el ? (("value" in el) ? el.value : el.textContent) : "";
    if (code && code.trim()) return code.trim();

    // 2) CodeMirror에서 코드 추출
    const cm = document.querySelector(".CodeMirror-code");
    if (cm) {
      const lines = [...cm.querySelectorAll(":scope > div > pre")].map(
        (p) => p.textContent || ""
      );
      code = lines.join("\n");
    }
    return (code || "").trim();
  }

  let tries = 0;
  const maxTries = 30; // ~6초 (200ms 간격)
  const timer = setInterval(() => {
    tries++;
    const code = grabOnce();
    if (code) {
      clearInterval(timer);
      chrome.runtime.sendMessage({ type: "sourceCode", submissionId: sid, code });
      console.log(`[UJAX] 소스 코드 추출 완료: ${sid}번 (${code.length}자)`);
    } else if (tries >= maxTries) {
      clearInterval(timer);
      chrome.runtime.sendMessage({ type: "sourceCode", submissionId: sid, code: "" });
      console.warn(`[UJAX] 소스 코드 추출 실패: ${sid}번 (타임아웃)`);
    }
  }, 200);
})();
