import { config } from '../src/config.js';
import { WecomClient } from '../src/wecom/client.js';

const wecom = new WecomClient(config.wecom);
const API = 'https://qyapi.weixin.qq.com/cgi-bin';

async function main() {
  // 1) gettoken：验证 CorpId + Secret
  console.log('== 1) gettoken（验证 CorpId + Secret）==');
  const token = await wecom.getAccessToken();
  console.log(`✅ access_token 获取成功: ${token.slice(0, 10)}…`);

  // 2) 查成员，找一个可接收消息的 userid
  console.log('== 2) 查询企业成员（部门1）==');
  const listRes = await fetch(`${API}/user/list?access_token=${encodeURIComponent(token)}&department_id=1&fetch_child=1`);
  const listData = await listRes.json();
  if (listData.errcode !== 0) {
    console.log(`⚠️ 查询成员失败: ${listData.errcode} ${listData.errmsg}`);
    // 若查不到成员，尝试 @all
  }
  const members = listData.userlist ?? [];
  console.log(`成员数: ${members.length}`);
  const touser = members[0]?.userid;
  if (!touser) {
    console.log('⚠️ 没查到成员 userid，改用 @all 测试（仅发给可见范围成员）');
    await wecom.sendText('@all', '【DSH 桥接自测】如果你能看到这条消息，说明企业微信配置正确 ✅');
    console.log('✅ 已发送测试消息（@all）');
  } else {
    console.log(`目标成员: ${touser}（${members[0]?.name ?? ''}）`);
    const r = await wecom.sendText(touser, '【DSH 桥接自测】如果你能看到这条消息，说明企业微信配置正确 ✅');
    console.log(`✅ 已发送测试消息到 ${touser}，errcode=${r.errcode}`);
  }
}

main().catch((e) => {
  console.error('❌ 企业微信验证失败:', e.message);
  process.exit(1);
});
