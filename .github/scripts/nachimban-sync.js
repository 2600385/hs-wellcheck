// 나침반(웰체크 활성화 통합 플랫폼) → hs-wellcheck 자동 반영 러너.
// 1) 나침반 웹앱을 브라우저로 열어(사번 입력 전 단계에서 이미 전체 데이터를 불러옴) 오늘자 현황과 월마감 파일
//    스냅샷만 꺼내고, 2) 이 저장소의 index.html을 로컬에서 띄워 runNachimbanSync()로 반영한다 - RAW 파일
//    업로드와 같은 commitCurrentRaw() 경로라 사무소 배정 보호·월마감 잠금 규칙이 그대로 적용됨.
// 저장소가 공개라 Actions 로그도 공개됨 - 나침반 주소는 Secrets(NACHIMBAN_URL)로만 받고, 로그에는 거래처명·
// 금액 같은 실제 데이터 없이 건수/성공 여부만 찍는다.
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PW_MODULE || 'playwright');

let NB_URL = process.env.NACHIMBAN_URL;
const APP_OFFICE = process.env.APP_OFFICE || '경인1';
const INDEX = path.resolve(__dirname, '..', '..', 'index.html');
// 저장소의 index.html을 실제 배포 주소인 것처럼 띄움(요청을 가로채 로컬 파일로 응답) - 별도 서버 없이
// 지금 저장소에 있는 코드 그대로 실행되고, Supabase 등 외부 요청은 평소처럼 나감
const APP_URL = 'https://hs-wellcheck.vercel.app/__nachimban_sync';

// 실패했을 때 무엇을 봤는지 로그로 남김(공개 로그라 거래처 데이터 없이 페이지 제목·프레임 주소의 호스트·
// 나침반 로딩 문구만) - 2026-10-28 GitHub 첫 예약 실행이 "데이터를 불러오지 못했어요"로만 끝나서 원인을 못 봤음
async function describePage(page) {
  const out = { title: await page.title().catch(() => ''), frames: [] };
  for (const f of page.frames()) {
    let host = '';
    try { host = new URL(f.url()).hostname; } catch (e) { /* about:blank 등 */ }
    const st = await f.evaluate(() => {
      const inp = document.querySelector('input');
      const box = document.getElementById('errBox');
      return {
        wc: typeof window.WC_DATA,
        placeholder: inp ? inp.placeholder : null,
        err: box ? box.textContent.slice(0, 200) : null,
        text: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 160),
      };
    }).catch((e) => ({ evalError: String(e && e.message).slice(0, 80) }));
    out.frames.push(Object.assign({ host }, st));
  }
  return out;
}

async function readNachimban(browser) {
  const page = await browser.newPage();
  let frame = null, ready = false;
  // 나침반은 데이터를 4번에 나눠 받은 뒤(현황 → 처방 → 간호사 → 웰체크 시트) 앱을 시작하면서 "웰체크 공유
  // 시트" 기반 오늘자 스냅샷(key가 wc로 시작)을 만든다 - 그게 생길 때까지 기다림. Google 쪽이 가끔 느리거나
  // 일시 오류를 내므로 한 번 실패하면 페이지를 새로 열어 한 번 더 시도.
  for (let attempt = 1; attempt <= 2 && !ready; attempt++) {
    frame = null;
    await page.goto(NB_URL, { waitUntil: 'load', timeout: 120000 });
    for (let i = 0; i < 150 && !ready; i++) {
      for (const f of page.frames()) {
        try {
          const st = await f.evaluate(() => {
            const D = window.WC_DATA;
            if (!D || !D.meta) return 0;
            return String(D.meta.current || '').startsWith('wc') ? 2 : 1;
          });
          if (st) frame = f;
          if (st === 2) { ready = true; break; }
        } catch (e) { /* 아직 로드 중인 프레임 */ }
      }
      if (!ready) await page.waitForTimeout(2000);
    }
    if (!ready) console.log(`⚠ ${attempt}번째 시도에서 나침반 오늘자 데이터를 못 찾음:`, JSON.stringify(await describePage(page)));
  }
  if (!frame) throw new Error('나침반 데이터를 불러오지 못했어요(페이지 구조가 바뀌었거나 접속 실패).');
  if (!ready) console.log('⚠ 웰체크 공유 시트(오늘자)가 아직 안 만들어져서 나침반의 최신 회사 파일 스냅샷으로 반영합니다.');
  const data = await frame.evaluate(() => {
    const D = window.WC_DATA;
    const cur = D.snapshots.find((s) => s.key === D.meta.current);
    const pick = (s) => ({ key: s.key, month: s.month, asOf: s.asOf, label: s.label, final: !!s.final, off: s.off, mr: s.mr, accounts: s.accounts });
    const finals = D.snapshots.filter((s) => s.final && s !== cur && (s.accounts || []).length);
    // 오늘자 시트에 아직 없는 신규 거래처를 채우는 데 쓰는, 이번 달 최신 회사 파일 스냅샷
    const files = D.snapshots.filter((s) => cur && s !== cur && !s.final && !String(s.key).startsWith('wc') && s.month === cur.month && (s.accounts || []).length)
      .sort((a, b) => String(a.asOf) < String(b.asOf) ? -1 : 1);
    const latestFile = files.length ? [files[files.length - 1]] : [];
    return { meta: { current: D.meta.current }, wc: { updated: D.wc && D.wc.updated }, snapshots: [cur].concat(latestFile, finals).filter(Boolean).map(pick) };
  });
  await page.close();
  return data;
}

async function applyToApp(browser, data) {
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  const html = fs.readFileSync(INDEX);
  await page.route(APP_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(APP_URL, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => typeof window.runNachimbanSync === 'function' && typeof window.db !== 'undefined', null, { timeout: 60000 });
  return page.evaluate(async ({ data, office }) => {
    window.alert = () => {};
    window.confirm = () => true;
    // 업로드 권한(관리자 "전체" 업로드)과 같은 조건으로 실행
    currentUser = { id: 0, emp_no: 'nachimban-bot', name: '나침반 자동', role: '관리자', office: office };
    currentOffice = office;
    IMPORT_MODE = 'full';
    return runNachimbanSync(data);
  }, { data, office: APP_OFFICE });
}

(async () => {
  if (!NB_URL) {
    console.error('NACHIMBAN_URL 시크릿이 없어요. 저장소 Settings → Secrets and variables → Actions에 나침반 주소를 등록해 주세요.');
    process.exit(1);
  }
  // 시크릿을 붙여넣을 때 앞뒤 공백·줄바꿈이 같이 들어가는 경우가 많아서 정리하고, 주소 형식만 확인(주소 자체는 안 찍음)
  NB_URL = NB_URL.trim();
  try {
    const u = new URL(NB_URL);
    console.log(`나침반 주소 확인: ${u.hostname}, ${u.pathname.endsWith('/exec') ? '/exec로 끝남(정상)' : '⚠ /exec로 끝나지 않음 - 주소를 다시 확인해 주세요'}`);
  } catch (e) {
    console.error('NACHIMBAN_URL 값이 올바른 주소 형식이 아니에요. 나침반 주소 전체(https://...)를 다시 등록해 주세요.');
    process.exit(1);
  }
  const launchOpts = {};
  if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;
  if (process.env.PW_PROXY) launchOpts.proxy = { server: process.env.PW_PROXY };
  const browser = await chromium.launch(launchOpts);
  try {
    const data = await readNachimban(browser);
    const cur = data.snapshots[0] || {};
    console.log(`나침반 데이터: ${cur.key} (${cur.asOf}), 거래처 ${(cur.accounts || []).length}곳, 회사 파일 스냅샷 ${data.snapshots.length - 1}개`);
    const res = await applyToApp(browser, data);
    const c = res.commit || {};
    const f = res.finals || {};
    console.log(`반영 결과: ${res.ok ? '성공' : '실패'} · 기준일 ${res.asOf || '-'} · 거래처 ${c.clinics || 0}곳 · 사무소 ${c.offices || 0}곳 · 사무소 표기 다른 거래처 ${c.conflicts || 0}곳`
      + ` · 오늘자 시트에 없어 회사 파일(${res.fileSnap || '-'})로 채운 거래처 ${res.filled || 0}곳`
      + ` · 지난달 마감 갱신 ${f.rows || 0}건${(f.months || []).length ? '(' + f.months.join(',') + ')' : ''}`
      + ` · 새로 등록한 담당자 ${((res.managersAdded || {}).added || []).length}명`);
    if (!res.ok) {
      console.error('실패 원인:', res.error || c.claimError || f.error || '알 수 없음');
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('실행 오류:', e && e.message ? e.message : e);
  process.exit(1);
});
