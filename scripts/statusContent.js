// statusContent.js
// ──────────────────────────────────────────────────────────────
// 백준 채점 현황 페이지(acmicpc.net/status)에서 실행되는 Content Script
// 첫 번째 행이 '기다리는/채점' 상태일 때만 감시하여, 채점 완료 시 1회 전송한다.
// expectingSubmission 플래그가 있으면 이미 최종 결과여도 즉시 전송한다.
// ──────────────────────────────────────────────────────────────
(function () {
  const WAIT_RE = /(기다리는|채점 준비 중|채점 중|컴파일 중|Judging|Waiting|Compiling|Preparing)/;
  let observing = false;
  let sent = false;
  let expectingNew = false;

  // 자동 제출 플래그 확인 (background.js가 제출 전 설정)
  chrome.storage.local.get("expectingSubmission", ({ expectingSubmission }) => {
    if (expectingSubmission) {
      expectingNew = true;
      chrome.storage.local.remove("expectingSubmission");
    }
  });

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

  function sendResult(data) {
    if (sent) return;
    sent = true;
    clearInterval(iv);
    chrome.runtime.sendMessage({ type: "submissionData", data });
    console.log(`[UJAX] 채점 결과 전송: ${data.submissionId}번 (${data.verdict})`);
  }

  function attachObserver() {
    if (observing || sent) return;

    const row = pickFirstRow();
    if (!row) return;

    const dataNow = parseRow(row);
    if (!dataNow) return;

    if (!WAIT_RE.test(dataNow.verdict)) {
      // 이미 최종 결과 — 자동 제출로 열린 탭이면 즉시 전송, 아니면 스킵
      if (expectingNew) {
        console.log(`[UJAX] 최종 결과 즉시 감지: ${dataNow.submissionId}번 (${dataNow.verdict})`);
        sendResult(dataNow);
      }
      return;
    }

    // 대기 중 → observer 설정
    observing = true;
    expectingNew = false; // 이미 감지 시작
    console.log(`[UJAX] 채점 대기 감지: ${dataNow.submissionId}번 (${dataNow.verdict})`);

    const verdictCell = row.querySelector("td:nth-child(4)");
    if (!verdictCell) return;

    const mo = new MutationObserver(() => {
      if (sent) return;
      const updated = parseRow(row);
      if (!updated) return;
      if (WAIT_RE.test(updated.verdict)) return; // 아직 채점 중
      mo.disconnect();
      sendResult(updated);
    });

    mo.observe(verdictCell, { childList: true, subtree: true, characterData: true });
  }

  // 행이 늦게 그려지는 경우 대비, 주기적으로 observer 부착 시도
  const iv = setInterval(() => {
    if (sent) { clearInterval(iv); return; }
    attachObserver();
  }, 400);

  console.log("[UJAX] 채점 현황 모니터링 시작");
})();
