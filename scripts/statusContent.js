// statusContent.js
// ──────────────────────────────────────────────────────────────
// 백준 채점 현황 페이지(acmicpc.net/status)에서 실행되는 Content Script
// 첫 번째 행이 '기다리는/채점' 상태일 때만 감시하여, 채점 완료 시 1회 전송한다.
// 이미 채점 완료된 상태(이전 제출)라면 무시한다.
// ──────────────────────────────────────────────────────────────
(function () {
  const WAIT_RE = /(기다리는|채점 중|컴파일 중|Judging|Waiting|Compiling|Preparing)/;
  let observing = false;
  let sent = false;

  function pickFirstRow() {
    return document.querySelector("#status-table tbody tr");
  }

  function parseRow(tr) {
    const tds = tr?.querySelectorAll("td");
    if (!tds || tds.length < 8) return null;

    const submissionId = (tds[0]?.innerText || "").trim();
    const username = (tds[1]?.innerText || "").trim();
    const link = tds[2]?.querySelector("a");
    const problemNum = link
      ? Number(new URL(link.href).pathname.split("/").pop())
      : Number((tds[2]?.innerText || "").replace(/\D/g, "")) || null;
    const verdict = (tds[3]?.innerText || "").trim();
    const memory = (tds[4]?.innerText || "").trim();
    const time = (tds[5]?.innerText || "").trim();
    const language = (tds[6]?.innerText || "").trim();
    const codeLength = (tds[7]?.innerText || "").trim();

    return { submissionId, username, problemNum, verdict, time, memory, language, codeLength };
  }

  function attachObserver() {
    if (observing || sent) return;

    const row = pickFirstRow();
    if (!row) return;

    const dataNow = parseRow(row);
    if (!dataNow) return;

    // 첫 로딩 시 이미 채점 완료 상태 → 이전 제출이므로 스킵
    if (!WAIT_RE.test(dataNow.verdict)) return;

    const verdictCell = row.querySelector("td:nth-child(4)");
    if (!verdictCell) return;

    observing = true;
    console.log(`[UJAX] 채점 대기 감지: ${dataNow.submissionId}번 (${dataNow.verdict})`);

    const mo = new MutationObserver(() => {
      if (sent) return;
      const updated = parseRow(row);
      if (!updated) return;
      if (WAIT_RE.test(updated.verdict)) return; // 아직 채점 중

      // 최종 결과 확정 → 1회 전송
      sent = true;
      mo.disconnect();
      chrome.runtime.sendMessage({ type: "submissionData", data: updated });
      console.log(`[UJAX] 채점 완료 전송: ${updated.submissionId}번 (${updated.verdict})`);
    });

    mo.observe(verdictCell, { childList: true, subtree: true, characterData: true });
  }

  // 행이 늦게 그려지는 경우 대비, 주기적으로 observer 부착 시도
  const iv = setInterval(() => {
    if (sent) { clearInterval(iv); return; }
    attachObserver();
  }, 400);

  console.log("[UJAX] 채점 현황 모니터링 시작 (채점 대기 → 완료 감시)");
})();
