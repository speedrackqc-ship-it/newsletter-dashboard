import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 1. 등록된 뉴스레터 발신자 목록 가져오기
const { data: newsletters, error: nlError } = await supabase
  .from('newsletters')
  .select('id, name, sender_email');

if (nlError) {
  console.error('뉴스레터 목록 조회 실패:', nlError);
  process.exit(1);
}

const senderMap = new Map(
  newsletters.map(n => [n.sender_email.toLowerCase(), n])
);

console.log(`📋 ${newsletters.length}개 뉴스레터 발신자 등록됨`);
newsletters.forEach(n => console.log(`  - ${n.name} <${n.sender_email}>`));

// 2. 네이버 IMAP 접속
const client = new ImapFlow({
  host: process.env.IMAP_HOST,
  port: parseInt(process.env.IMAP_PORT),
  secure: true,
  auth: {
    user: process.env.NAVER_EMAIL,
    pass: process.env.NAVER_APP_PASSWORD
  },
  logger: false
});

await client.connect();
console.log('✅ IMAP 접속 성공');

const lock = await client.getMailboxLock('INBOX');

try {
  // 3. 최근 7일치 메일 가져오기
  const since = new Date();
  since.setDate(since.getDate() - 7);

  const messages = client.fetch(
    { since },
    { source: true, envelope: true, uid: true }
  );

  let totalChecked = 0;
  let matchedCount = 0;
  let savedCount = 0;
  let unknownSenders = new Set();

  for await (const message of messages) {
    totalChecked++;

    const parsed = await simpleParser(message.source);
    const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase();

    if (!fromAddress) continue;

    const newsletter = senderMap.get(fromAddress);

    if (!newsletter) {
      unknownSenders.add(fromAddress);
      continue;
    }

    matchedCount++;

    const messageId = parsed.messageId ||
      `${parsed.date?.toISOString()}-${fromAddress}`;

    const { error: insertError, data: inserted } = await supabase
      .from('issues')
      .upsert({
        newsletter_id: newsletter.id,
        message_id: messageId,
        subject: parsed.subject || '(제목 없음)',
        body_html: parsed.html || null,
        body_text: parsed.text || null,
        received_at: parsed.date?.toISOString() || new Date().toISOString(),
      }, {
        onConflict: 'message_id',
        ignoreDuplicates: true
      })
      .select();

    if (insertError) {
      console.error(`❌ ${newsletter.name} 저장 실패:`, insertError.message);
    } else if (inserted && inserted.length > 0) {
      savedCount++;
      console.log(`📩 새로 저장: [${newsletter.name}] ${parsed.subject?.slice(0, 50)}`);
    }
  }

  console.log(`\n📊 결과 요약`);
  console.log(`  확인한 메일: ${totalChecked}통`);
  console.log(`  뉴스레터 매칭: ${matchedCount}통`);
  console.log(`  새로 저장: ${savedCount}통`);

  if (unknownSenders.size > 0) {
    console.log(`\n⚠️  등록 안 된 발신자 ${unknownSenders.size}명 발견:`);
    [...unknownSenders].slice(0, 10).forEach(s => console.log(`  - ${s}`));
    console.log(`  → newsletters 테이블에 추가하면 다음 실행 때부터 자동 수집됨`);
  }

} finally {
  lock.release();
  await client.logout();
}
