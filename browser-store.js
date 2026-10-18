/* GitHub Pages adapter. No server, credentials, timers, or hidden collection.
 * Source observations and private workflow records live in separate structures.
 * A transaction reaches localStorage before becoming visible to this session.
 */
(function (root) {
  'use strict';
  const KEY = 'jian-homewatch-browser-v1', SCHEMA = 1, MAX_BYTES = 2 * 1024 * 1024, MAX_BACKUP_BYTES = 6 * 1024 * 1024;
  const BOOLS = ['elevator','parking_usable','move_in_ready','young_style','amenities','school_verified','in_excluded_zone'];
  const EDITABLE = ['title','community','district','address','rooms','bathrooms','area_m2','floor','decoration','housing_type','status','raw_text','source_kind','data_issues',...BOOLS];
  const STAGES = ['收集','已联系','待看房','已看房','议价','付定金','待签约','贷款办理','过户交房','已完成','已放弃'];
  const STATUSES = ['未知','平台展示','已确认在售','已下架','已成交'];
  const CHECK_STATUS = ['待核实','通过','有风险','不适用','待复核'];
  const DEFAULTS = {budget_yuan:750000,stretch_yuan:800000,max_down_payment_yuan:400000,budget_basis:'purchase_total',estimated_fees_yuan:20000,estimated_refresh_yuan:30000,stale_hours:72,price_alert_yuan:10000,price_alert_pct:2,priority_communities:[],monitor_until:'2027-01-17',digest_hour:9};
  const ALIASES = {'来源':'source','来源名称':'source','房源编号':'source_item_id','来源房源编号':'source_item_id','详情链接':'url','来源链接':'url','小区':'community','小区名称':'community','区域':'district','总价万元':'price_wan','总价（万元）':'price_wan','价格元':'price_yuan','面积㎡':'area_m2','建筑面积':'area_m2','房数':'rooms','卫数':'bathrooms','电梯':'elevator','停车可落实':'parking_usable','年轻化装修':'young_style','少量整理入住':'move_in_ready','生活配套':'amenities','学区已核实':'school_verified','位于排除区域':'in_excluded_zone','状态':'status','观测时间':'observed_at','原始描述':'raw_text','来源类型':'source_kind','地址':'address','楼层':'floor','房源类别':'housing_type','信息问题':'data_issues'};
  let db, bootstrap, queue = Promise.resolve(), initialized, feedReadError, savedValue;
  const clone = x => JSON.parse(JSON.stringify(x));
  const now = () => new Date().toISOString();
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const own = (x,k) => Object.prototype.hasOwnProperty.call(x,k);
  const text = (x,max=500) => String(x == null ? '' : x).trim().slice(0,max);
  const size = x => new TextEncoder().encode(x).length;
  const names = x => String(x || '').replace(/[\s·•・\-—（）()]+/g,'').toLowerCase();
  function fail(message) { throw new Error(message); }
  function time(value) {
    const match=typeof value==='string'&&value.match(/^\d{4}-\d\d-\d\dT(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(?:Z|[+-](\d\d):(\d\d))$/i);
    if (!match || Number(match[1])>23 || Number(match[2])>59 || Number(match[3]||0)>59 || Number(match[4]||0)>23 || Number(match[5]||0)>59 || !Number.isFinite(Date.parse(value))) fail('时间必须为带时区的 ISO 8601，例如 2026-10-17T09:00:00+08:00');
    const calendar=value.slice(0,10), test=new Date(calendar+'T00:00:00Z');
    if (!Number.isFinite(test.getTime()) || test.toISOString().slice(0,10)!==calendar) fail('观测时间中的日期不合法');
    return new Date(value).toISOString();
  }
  function recordTime(value){const out=time(value);if(Date.parse(out)>Date.now()+300000)fail('备份记录时间不能在未来');return out;}
  function numeric(v,label,min,max,integer=false) {
    if (typeof v === 'boolean' || v === null || String(v).trim() === '') fail(label+'须填写数值');
    const n=Number(v);
    if (!Number.isFinite(n) || n<min || n>max || (integer&&!Number.isInteger(n))) fail(label+'数值不合法');
    return n;
  }
  function money(v,mult=1) {
    if (v===null || v===undefined || v==='') return null;
    return Math.round(numeric(v,'金额',0,1e9/mult)*mult);
  }
  function tri(v) {
    if (v===null || v===undefined || ['', '未知','待核实','null'].includes(v)) return null;
    if ([true,1,'1','true','True','是','有'].includes(v)) return true;
    if ([false,0,'0','false','False','否','无'].includes(v)) return false;
    fail('不能识别的是/否/未知值：'+String(v).slice(0,50));
  }
  function canon(value) {
    const valueText=text(value,4000); if (!valueText) return '';
    let u; try {u=new URL(valueText);} catch {fail('来源链接必须是完整的 http/https 地址');}
    if (!['http:','https:'].includes(u.protocol) || !u.hostname || u.username || u.password) fail('来源链接必须是 http/https，且不能包含账号密码');
    const tracking=new Set(['from','position','fb_expo_id','spm','isauction','utm_source','utm_medium','utm_campaign']);
    const entries=[...u.searchParams].filter(([k])=>!tracking.has(k)).sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0);
    u.search=''; for (const [k,v] of entries) u.searchParams.append(k,v);
    u.hash=''; u.pathname=u.pathname.replace(/\/+$/,'');
    return u.href.replace(/\/(?=\?|$)/,'');
  }
  function identity(d) {
    const u=d.url?new URL(d.url):null, host=u?u.hostname:'';
    if (/(^|\.)(ke|lianjia)\.com$/.test(host)) {
      const m=u.pathname.match(/\/ershoufang\/(\d+)/); if(m)return (/(^|\.)lianjia\.com$/.test(host)?'lianjia:':'beike:')+m[1];
    }
    if (/(^|\.)anjuke\.com$/.test(host)) {const m=u.pathname.match(/\/sale\/(A\d+)/);if(m)return 'anjuke:'+m[1];}
    if(d.source_item_id)return 'item:'+d.source+':'+d.source_item_id;
    if(d.url)return 'url:'+d.url;
    fail('请提供稳定的房源详情链接，或来源名称＋房源编号；不要使用整个搜索列表作为单套房源链接');
  }
  function normalize(row,requireTime=false) {
    if(!object(row))fail('每条房源必须是 JSON 对象');
    const d={};
    for(const k of ['source','source_item_id','title','community','district','address','floor','decoration','source_kind'])d[k]=text(row[k]);
    d.source=d.source||'手动记录';d.title=d.title||d.community||'待补充房源';d.url=canon(row.url);
    d.price_yuan=own(row,'price_yuan')?money(row.price_yuan):money(row.price_wan,10000);
    if(own(row,'price_yuan')&&own(row,'price_wan')&&d.price_yuan!==money(row.price_wan,10000))fail('price_yuan 与 price_wan 不一致，请只使用一种金额单位');
    if(d.price_yuan!==null&&d.price_yuan<=0)fail('报价必须大于零；未知价格请留空');
    for(const k of ['rooms','bathrooms'])d[k]=row[k]===null||row[k]===undefined||row[k]===''?null:numeric(row[k],k,0,30,true);
    d.area_m2=row.area_m2===null||row.area_m2===undefined||row.area_m2===''?null:numeric(row.area_m2,'建筑面积',0.000001,9999.999999);
    for(const k of BOOLS)d[k]=tri(row[k]);
    d.housing_type=row.housing_type||'未知';if(!['未知','二手房','精装现房','期房','其他'].includes(d.housing_type))fail('房源类别不正确');
    d.status=row.status||'未知';if(!STATUSES.includes(d.status))fail('房源状态不在允许范围内');
    if(requireTime&&!row.observed_at)fail('导入/同步须提供 observed_at 原始观测时间，不能把重复下载伪装成新核验');
    d.observed_at=time(row.observed_at||now());if(Date.parse(d.observed_at)>Date.now()+300000)fail('观测时间不能在未来');
    d.raw_text=String(row.raw_text||'').slice(0,16000);
    let issues=row.data_issues||[];if(typeof issues==='string')issues=issues.split('；').map(x=>x.trim()).filter(Boolean);
    if(!Array.isArray(issues)||issues.some(x=>typeof x!=='string'))fail('data_issues 必须是文本数组');
    d.data_issues=issues.slice(0,20).map(x=>x.slice(0,500));identity(d);return d;
  }
  function fingerprint(d) {
    const out={};for(const k of Object.keys(d).sort())if(!['observed_at','source','url','source_item_id'].includes(k))out[k]=d[k];
    return JSON.stringify(out);
  }
  function settings(patch,base=DEFAULTS) {
    if(!object(patch))fail('设置须为对象');const out={...base};for(const k of Object.keys(DEFAULTS))if(own(patch,k))out[k]=patch[k];
    for(const k of ['budget_yuan','stretch_yuan','max_down_payment_yuan','price_alert_yuan']){out[k]=money(out[k]);if(!out[k])fail('预算和金额阈值必须大于零');}
    if(!['purchase_total','listing_price'].includes(out.budget_basis))fail('预算口径须为购房总支出或挂牌房款');
    for(const k of ['estimated_fees_yuan','estimated_refresh_yuan']){out[k]=money(out[k]);if(out[k]===null)fail('交易费用和整备费假设须填写不小于零的金额');}
    if(out.stretch_yuan<out.budget_yuan)fail('弹性观察上限不能低于目标预算');
    out.stale_hours=numeric(out.stale_hours,'更新时效',1,720,true);out.digest_hour=numeric(out.digest_hour,'日报时间',0,23,true);out.price_alert_pct=numeric(out.price_alert_pct,'降价阈值',0.000001,100);
    if(typeof out.monitor_until!=='string'||!/^\d{4}-\d\d-\d\d$/.test(out.monitor_until)||time(out.monitor_until+'T00:00:00Z').slice(0,10)!==out.monitor_until)fail('观察截止日期不合法');
    if(!Array.isArray(out.priority_communities)||out.priority_communities.length>50||out.priority_communities.some(x=>typeof x!=='string'))fail('优先小区须为最多50项的文本数组');
    out.priority_communities=out.priority_communities.map(x=>text(x,100)).filter(Boolean);return out;
  }
  function alert(d,oid,kind,message) {d.alerts.push({id:++d.sequence,offer_id:oid,kind,message,created_at:now(),read_at:null,confirmation:''});}
  function audit(d,oid,action,detail) {d.audit.push({id:++d.sequence,offer_id:oid,action,detail,created_at:now()});}
  function invalidate(d,oid) {for(const c of Object.values(d.user[oid].checks))if(['通过','不适用'].includes(c.status))c.status='待复核';}
  function importRows(d,rows,requireTime=false,baseline=false) {
    if(!Array.isArray(rows)||rows.length>1000)fail('每批须为最多1000条的数组');
    const normalized=rows.map((r,i)=>{try{return normalize(r,requireTime);}catch(e){fail('第'+(i+1)+'条：'+e.message+'；整批未写入');}});
    const result={new:0,changed:0,unchanged:0,older_ignored:0,conflicts:0,ids:[]};
    for(const data of normalized){
      const key=identity(data),hash=fingerprint(data);let old=d.offers.find(x=>x.identity===key);
      if(!old){
        let id;do{id='b'+(++d.sequence).toString(36);}while(d.offers.some(x=>x.id===id));
        old={id,identity:key,data,first_seen:now(),last_seen:data.observed_at};d.offers.push(old);
        d.user[old.id]={stage:'收集',notes:'',group_id:'',checks:{}};result.new++;
        if(!baseline)alert(d,old.id,'新线索','新收录：'+data.title+'。这是首次发现，不代表刚挂牌。');
      }else{
        const incoming=Date.parse(data.observed_at),before=Date.parse(old.last_seen),oldHash=fingerprint(old.data);
        if(incoming<before){result.older_ignored++;audit(d,old.id,'忽略较旧观测',data.observed_at);result.ids.push(old.id);continue;}
        if(incoming===before&&hash!==oldHash){
          result.conflicts++;
          if(!d.snapshots.some(x=>x.offer_id===old.id&&x.observed_at===data.observed_at&&fingerprint(x.data)===hash)){
            alert(d,old.id,'数据冲突','同一房源同一观测时间有不同内容，未覆盖最新记录。');snapshot(d,old.id,data);
          }
          invalidate(d,old.id);result.ids.push(old.id);continue;
        }
        if(hash===oldHash){result.unchanged++;if(incoming>before){old.data=data;old.last_seen=data.observed_at;}result.ids.push(old.id);continue;}
        const prev=old.data,p0=prev.price_yuan,p1=data.price_yuan;
        if(p0&&p1&&p0!==p1){const delta=p0-p1,pct=delta/p0*100;
          if(delta>0&&(delta>=d.settings.price_alert_yuan||pct>=d.settings.price_alert_pct))alert(d,old.id,'报价下降待确认',(data.community||data.title)+'：'+p0/10000+' → '+p1/10000+' 万，下降 '+delta/10000+' 万（'+pct.toFixed(1)+'%）。仅为同一平台房源的报价变化，尚未经业主确认。');
          else if(delta<0)alert(d,old.id,'报价上涨',(data.community||data.title)+'：'+p0/10000+' → '+p1/10000+' 万。');
        }
        if(prev.status!==data.status)alert(d,old.id,'状态表述变化',data.title+'：'+prev.status+' → '+data.status+'。下架不等于成交。');
        if([...EDITABLE,'price_yuan'].some(k=>JSON.stringify(prev[k])!==JSON.stringify(data[k])))invalidate(d,old.id);
        old.data=data;old.last_seen=data.observed_at;result.changed++;
      }
      snapshot(d,old.id,data);result.ids.push(old.id);
    }
    return result;
  }
  function snapshot(d,oid,data){if(!d.snapshots.some(x=>x.offer_id===oid&&x.observed_at===data.observed_at&&fingerprint(x.data)===fingerprint(data)))d.snapshots.push({id:++d.sequence,offer_id:oid,observed_at:data.observed_at,captured_at:now(),data:clone(data)});}
  function cleared(c){return ['通过','不适用'].includes(c.status)&&typeof c.evidence==='string'&&c.evidence.trim().length>=5&&(!c.expires_days||(c.updated_at&&Date.now()-Date.parse(c.updated_at)<c.expires_days*86400000));}
  function checks(d,oid){return bootstrap.knowledge.checks.map(spec=>{const c={...spec,...(d.user[oid].checks[spec.id]||{status:'待核实',evidence:'',updated_at:null})};if(['通过','不适用'].includes(c.status)&&!cleared(c)){c.status='待复核';c.expired=true;}return c;});}
  function assessment(o,c,cfg){
    const failures=[],pending=[];
    if(['青原区','井开区','井冈山经济技术开发区'].includes(o.district)||o.in_excluded_zone===true)failures.push('区域不符合：排除青原区和井开区');
    else if(!['吉州区','吉安县'].includes(o.district))pending.push('实际行政归属待核实');
    if(o.in_excluded_zone===null)pending.push('需确认实际位置不在井开区/青原区');
    for(const [k,w,label] of [['rooms',3,'三房'],['bathrooms',2,'双卫']]){if(o[k]===null)pending.push(label+'未提供');else if(o[k]!==w)failures.push(label+'不符合');}
    for(const [k,label] of [['elevator','电梯'],['parking_usable','停车可落实'],['move_in_ready','少量整理可入住'],['amenities','日常生活配套'],['young_style','装修风格偏年轻']]){if(o[k]===false)failures.push(label+'不符合');else if(o[k]!==true)pending.push(label+'待核实');}
    if(['未知','其他'].includes(o.housing_type))pending.push('房源类别/是否可按住宅交易待核实');else if(o.housing_type==='期房')failures.push('期房不属于本版默认的可近期整理入住候选');
    const price=o.price_yuan,total=price===null?null:price+cfg.estimated_fees_yuan+cfg.estimated_refresh_yuan,compare=cfg.budget_basis==='purchase_total'?total:price,band=compare===null?'价格未知':compare<=cfg.budget_yuan?'目标预算内':compare<=cfg.stretch_yuan?'弹性观察':'高于观察线';
    if(band==='高于观察线')pending.push('价格高于暂定观察线，需你另行决定，不自动视为接受');if(price===null)pending.push('报价待补充');
    const priority=cfg.priority_communities.some(x=>names(x)&&names(o.community).includes(names(x)));
    const scores={'报价偏好':compare!==null&&compare<=cfg.budget_yuan?25:band==='弹性观察'?12:0,'三房双卫':o.rooms===3&&o.bathrooms===2?15:0,'电梯':o.elevator===true?10:0,'停车':o.parking_usable===true?10:0,'入住条件':o.move_in_ready===true?15:0,'装修风格':o.young_style===true?10:0,'生活配套':o.amenities===true?10:0,'学区加分':o.school_verified===true?2:0,'重点小区':priority?3:0};
    const unresolved=c.filter(x=>x.before_contract||x.id==='newhome'&&o.housing_type==='精装现房').filter(x=>!cleared(x)).map(x=>x.title),critical=c.filter(x=>x.status==='有风险').map(x=>x.title),stale=Date.now()-Date.parse(o.observed_at)>cfg.stale_hours*3600000;
    let status=failures.length?'不符合':pending.length||unresolved.length||critical.length||stale||o.status!=='已确认在售'||o.data_issues.length?'待核实':'核验已填齐';
    if(['已下架','已成交'].includes(o.status))status='非在售';
    return {status,failures,pending,budget_band:band,budget_basis:cfg.budget_basis,estimated_purchase_total_yuan:total,budget_compare_yuan:compare,priority,score:Object.values(scores).reduce((a,b)=>a+b,0),score_breakdown:scores,unresolved,critical,verified_checks:c.filter(cleared).length,total_checks:c.length,stale};
  }
  function list(d){return d.offers.map(o=>{
    const user=d.user[o.id],item={...clone(o.data),id:o.id,first_seen:o.first_seen,last_seen:o.last_seen,stage:user.stage,notes:user.notes,group_id:user.group_id};
    const versions=d.snapshots.filter(x=>x.offer_id===o.id&&x.observed_at===o.last_seen);
    if(new Set(versions.map(x=>fingerprint(x.data))).size>1)item.data_issues.push('当前观测时刻存在冲突内容，需新的、有依据的观测解决');
    item.checks=checks(d,o.id);item.assessment=assessment(item,item.checks,d.settings);return item;
  }).sort((a,b)=>Number(b.assessment.priority)-Number(a.assessment.priority)||b.assessment.score-a.assessment.score||Date.parse(b.first_seen)-Date.parse(a.first_seen));}
  function offer(d,id){const item=list(d).find(x=>x.id===id);if(!item)fail('房源不存在');item.history=d.snapshots.filter(x=>x.offer_id===id).sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at)||a.id-b.id).map(x=>({id:x.id,observed_at:x.observed_at,captured_at:x.captured_at,data:clone(x.data)}));item.audit=d.audit.filter(x=>x.offer_id===id).slice(-100).reverse();return item;}
  function duplicates(offers){const out=[];for(let i=0;i<offers.length;i++)for(let j=i+1;j<offers.length&&out.length<100;j++){const a=offers[i],b=offers[j];if(names(a.community)&&names(a.community)===names(b.community)&&a.area_m2&&b.area_m2&&Math.abs(a.area_m2-b.area_m2)<=2&&a.rooms===b.rooms)out.push({left:a.id,right:b.id,community:a.community,reason:'同小区、同房数、面积差≤2㎡；只提示疑似重复，不自动合并，跨平台报价不当成降价。'});}return out;}
  function leadId(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(value)||['constructor','prototype','__proto__'].includes(value))fail('公开线索 ID 不合法');return value;}
  function normalizeLead(raw){
    if(!object(raw))fail('公开线索须为对象');
    const out={lead_id:leadId(raw.lead_id),source_url:canon(raw.source_url)};if(!out.source_url)fail('公开线索缺少来源链接');
    for(const k of ['source_item_id','community','district','decoration_claim','collection_run_id','parser_version','access_status'])out[k]=text(raw[k],k==='decoration_claim'?1000:200)||null;
    if(!['search_index','direct_listing'].includes(raw.evidence_kind))fail('公开线索证据类型不支持');out.evidence_kind=raw.evidence_kind;
    out.source_domain=new URL(out.source_url).hostname;out.identity_scope=raw.identity_scope==='source_item'?'source_item':'search_entry';
    out.retrieved_at=recordTime(raw.retrieved_at);
    for(const k of ['source_updated_at','source_published_at','discovered_at'])out[k]=raw[k]?recordTime(raw[k]):null;
    for(const k of ['rooms','bathrooms'])out[k]=raw[k]===null||raw[k]===undefined||raw[k]===''?null:numeric(raw[k],k,0,30,true);
    out.price_wan=raw.price_wan===null||raw.price_wan===undefined||raw.price_wan===''?null:numeric(raw.price_wan,'公开广告价（万元）',0.000001,100000);
    out.area_m2=raw.area_m2===null||raw.area_m2===undefined||raw.area_m2===''?null:numeric(raw.area_m2,'公开建筑面积',0.000001,9999.999999);
    for(const k of BOOLS)out[k]=tri(raw[k]);
    if(raw.freshness_unknown!==undefined&&typeof raw.freshness_unknown!=='boolean')fail('freshness_unknown 须为布尔值');
    // A search index fetch time never establishes the age of the underlying advert.
    out.freshness_unknown=raw.evidence_kind==='search_index'||!out.source_updated_at||raw.freshness_unknown!==false;
    if(raw.uncertainties!==undefined&&(!Array.isArray(raw.uncertainties)||raw.uncertainties.some(x=>typeof x!=='string')||raw.uncertainties.length>40))fail('公开线索待核项须为文本数组');
    out.uncertainties=(raw.uncertainties||[]).map(x=>text(x,500));return out;
  }
  function leadAssessment(lead,cfg){
    const failures=[],pending=[],price=lead.price_wan===null?null:Math.round(lead.price_wan*10000),total=price===null?null:price+cfg.estimated_fees_yuan+cfg.estimated_refresh_yuan,compare=cfg.budget_basis==='listing_price'?price:total;
    if(['青原区','井开区','井冈山经济技术开发区'].includes(lead.district)||lead.in_excluded_zone===true)failures.push('区域不符合：排除青原区和井开区');else if(!['吉州区','吉安县'].includes(lead.district))pending.push('实际行政归属待核实');
    for(const [key,w,label] of [['rooms',3,'三房'],['bathrooms',2,'双卫']]){if(lead[key]===null)pending.push(label+'未知');else if(lead[key]!==w)failures.push(label+'不符合');}
    for(const [key,label] of [['elevator','电梯'],['parking_usable','不买车位能停车'],['move_in_ready','少量整理可入住'],['young_style','装修偏年轻'],['amenities','日常生活配套']]){if(lead[key]===false)failures.push(label+'不符合');else pending.push(label+(lead[key]===true?'需现场确认广告表述':'待核实'));}
    if(/毛坯/.test((lead.decoration_claim||'').replace(/非毛坯|不是毛坯|并非毛坯/g,'')))failures.push('广告称毛坯，不符合少量整理入住要求');
    if(price===null)pending.unshift('实际报价待补充');
    const budget_band=compare===null?'价格未知':compare<=cfg.budget_yuan?'目标预算内':compare<=cfg.stretch_yuan?'弹性观察':'高于观察线';
    const questions=[...new Set([...failures,...lead.uncertainties,...pending,'请确认这是同一套住宅、目前仍可出售，当前业主报价及全部费用分别是多少？','请提供近期全屋视频、卫生间和厨房实拍；确认产权、抵押查封与银行可贷额度。'])];
    return {failures,pending,budget_band,budget_basis:cfg.budget_basis,estimated_purchase_total_yuan:total,budget_compare_yuan:compare,next_checks:questions,status:failures.length?'广告信息不符':'待核实线索'};
  }
  function leads(d){return d.leads.map(entry=>({...clone(entry.data),in_latest_feed:entry.in_latest_feed,conflict:entry.conflicts.length>0,history_count:entry.history.length,followup:clone(d.lead_user[entry.lead_id]||{saved:false,notes:'',updated_at:null}),assessment:leadAssessment(entry.data,d.settings)})).sort((a,b)=>Number(a.assessment.failures.length>0)-Number(b.assessment.failures.length>0)||Number(b.followup.saved)-Number(a.followup.saved)||Number(a.price_wan===null)-Number(b.price_wan===null)||Date.parse(b.retrieved_at)-Date.parse(a.retrieved_at));}
  function leadDetail(d,id){const item=leads(d).find(x=>x.lead_id===id),entry=d.leads.find(x=>x.lead_id===id);if(!item)fail('公开线索不存在');return {...item,history:clone(entry.history),conflicts:clone(entry.conflicts)};}
  function state(){const offers=list(db),health=clone(db.source_health),published=db.public_feed;if(feedReadError)health._public_feed={...(health._public_feed||{}),error:feedReadError,next_run:null};return {csrf:'browser-local',version:bootstrap.version||'0.4.0',offers,leads:leads(db),research:clone(published.research),public_feed_schema_version:published.schema_version,alerts:db.alerts.slice(-500).reverse(),settings:clone(db.settings),stages:clone(STAGES),statuses:clone(STATUSES),knowledge:clone(bootstrap.knowledge),sources:clone(db.sources),source_health:health,duplicates:duplicates(offers),server_started_at:null,worker_error:'',mail_configured:false,active_sources:0,configured_sources:db.sources.filter(x=>x.enabled&&x.authorized).length,mode:'browser',storage_mode:'localStorage',background_collection:false,feed_status:clone(health._public_feed||{}),public_sources:clone(published.sources),public_source_health:clone(published.source_health),published_monitoring:clone(published.monitoring),public_feed_generated_at:published.generated_at,storage_notice:'记录仅保存在此浏览器；清除网站数据或更换设备不会自动保留，请定期下载浏览器备份。'};}
  function csvCells(input){
    const rows=[];let row=[],cell='',quoted=false,ended=false;
    for(let i=0;i<input.length;i++){const c=input[i];if(quoted){if(c==='"'){if(input[i+1]==='"'){cell+='"';i++;}else {quoted=false;ended=true;}}else cell+=c;}
      else if(c==='"'){if(cell||ended)fail('CSV 引号格式不正确');quoted=true;}
      else if(c===','){row.push(cell);cell='';ended=false;}
      else if(c==='\r'||c==='\n'){if(c==='\r'&&input[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x!==''))rows.push(row);row=[];cell='';ended=false;}
      else {if(ended)fail('CSV 引号结束后须为逗号或换行');cell+=c;}}
    if(quoted)fail('CSV 存在未结束的引号');row.push(cell);if(row.some(x=>x!==''))rows.push(row);return rows;
  }
  function decode(input,fmt='json',allowEmpty=false){
    if(typeof input!=='string'||size(input)>MAX_BYTES)fail('导入内容须为不超过2MB的 UTF-8 文本');input=input.replace(/^\uFEFF/,'');let rows;
    if(fmt==='json'){let payload;try{payload=JSON.parse(input);}catch{fail('JSON 格式不正确');}if(object(payload)&&own(payload,'schema_version')&&payload.schema_version!==1)fail('数据源 schema_version 不兼容，当前只接受版本1');rows=object(payload)?payload.listings:payload;}
    else if(fmt==='csv'){const lines=csvCells(input),headers=(lines.shift()||[]).map(x=>ALIASES[x.trim()]||x.trim());if(new Set(headers).size!==headers.length)fail('CSV 存在重复或等价字段列');rows=lines.map(line=>{if(line.length!==headers.length)fail('CSV 数据列数与表头不一致');const row={};headers.forEach((h,i)=>row[h]=line[i]);return row;});}
    else fail('格式须为 csv 或 json');
    if(!Array.isArray(rows)||rows.length>1000)fail('每批须为最多1000条的数组');if(!rows.length&&!allowEmpty)fail('没有可导入的房源');
    return rows.map((r,i)=>{try{return normalize(r,true);}catch(e){fail('第'+(i+1)+'条：'+e.message+'；整批未保存');}});
  }
  function parse(input){
    const s=String(input||'').slice(0,16000),fields={raw_text:s,source_kind:'手动粘贴，待核实'},warnings=[];
    for(const [k,re] of [['price_wan',/(?:总价|售价|报价|价格)?\s*(\d+(?:\.\d+)?)\s*万(?:元)?/g],['rooms',/(\d+)\s*[室房]/g],['bathrooms',/(\d+)\s*卫/g],['area_m2',/(\d+(?:\.\d+)?)\s*(?:㎡|平米|平方米|m²)/gi]]){const values=[...new Set([...s.matchAll(re)].map(x=>x[1]))];if(values.length===1)fields[k]=Number(values[0]);else if(values.length>1)warnings.push(k+' 检测到多个数值，请人工选择，未自动填入');}
    const negative=/(?:无电梯|没有电梯|未装电梯)/.test(s),positive=/(?:有电梯|带电梯|电梯房|专梯专户)/.test(s.replace(/(?:无电梯|没有电梯|未装电梯)/g,''));
    if(negative&&positive)warnings.push('电梯表述存在冲突');else if(negative)fields.elevator=false;else if(positive)fields.elevator=true;
    if(s.includes('毛坯')&&!/非毛坯|不是毛坯/.test(s))fields.move_in_ready=false;
    if(s.includes('精装'))fields.decoration='平台/文本称精装，风格与入住条件待核实';
    const regions=['吉州区','吉安县','青原区','井开区','井冈山经济技术开发区'].filter(x=>s.includes(x));if(regions.length===1)fields.district=regions[0];else if(regions.length>1)warnings.push('文本出现多个地区，未自动判断行政归属');
    for(const c of DEFAULTS.priority_communities)if(names(s).includes(names(c))){fields.community=c;break;}
    const urls=s.match(/https?:\/\/[^\s<>"]+/g)||[];if(urls.length===1)fields.url=urls[0].replace(/[，。；]+$/,'');
    fields.data_issues=warnings;return {fields,warnings:[...warnings,'解析结果不是已核实事实；请核对是否为同一套房。停车、装修年轻化与可入住不会自动判为通过。']};
  }
  function calculate(body){
    const value=(k,def)=>money(own(body,k)?body[k]:def,10000),price=value('price_wan',75),down=value('down_wan',40),fees=value('fees_wan',2),refresh=value('refresh_wan',3),reserve=value('reserve_wan',0);
    if([price,down,fees,refresh,reserve].some(x=>x===null)||price<=0||down>price)fail('请填写全部测算参数，首付不能超过房价');
    const rate=numeric(own(body,'rate_pct')?body.rate_pct:3,'年利率',0,30)/100,years=numeric(own(body,'years')?body.years:30,'贷款年限',1,40,true),principal=price-down,n=years*12,r=rate/12,pmt=r?principal*r/(-Math.expm1(-n*Math.log1p(r))):principal/n;
    const available=value('available_cash_wan',null),approval=value('approved_loan_wan',null),cash=down+fees+refresh+reserve,round=x=>Math.round(x*100)/100;
    return {loan_yuan:principal,monthly_yuan:round(pmt),interest_yuan:round(pmt*n-principal),upfront_yuan:down+fees+refresh,cash_with_reserve_yuan:cash,purchase_total_yuan:price+fees+refresh,cash_gap_yuan:available===null?null:Math.max(0,cash-available),loan_gap_yuan:approval===null?null:Math.max(0,principal-approval),adjusted_cash_gap_yuan:available===null||approval===null?null:Math.max(0,cash+Math.max(0,principal-approval)-available),warning:'等额本息情景测算，不是贷款报价或授信。利率、税费、整备费均为可编辑假设。可贷额度、银行评估价与税费承担须单独核实；应急金不是购房费用。'};
  }
  function remoteURL(value){
    let u;try{u=new URL(String(value));}catch{fail('远程源须为完整的公网 HTTPS 地址');}
    if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443')fail('远程源必须使用不含账号密码的公网 HTTPS URL（443端口）');
    const host=u.hostname.toLowerCase().replace(/^\[|\]$/g,'');
    if(!host.includes('.')||host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host)||/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host))fail('浏览器模式仅允许公网域名；不访问本机、内网或 IP 地址');
    if([...u.searchParams.keys()].some(k=>/token|secret|password|key|auth|credential|sig/i.test(k)))fail('浏览器公开页面不能保存带密钥的地址，请使用无需凭据的授权数据源');
    return u.href;
  }
  function sources(input){
    if(!Array.isArray(input)||input.length>30)fail('最多配置30个数据源');const ids=new Set();
    return input.map(s=>{
      if(!object(s)||typeof s.id!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(s.id)||['constructor','prototype','__proto__'].includes(s.id)||ids.has(s.id))fail('来源 id 须为唯一的1—80位字母、数字、横杠或下划线');ids.add(s.id);
      if(s.token_env||s.token||s.password||s.secret||s.api_key)fail('浏览器模式不支持保存密钥或令牌环境变量；请使用本地服务处理凭据');
      if(!['json_file','json_https'].includes(s.type))fail('仅支持授权 JSON 文件 / HTTPS JSON 数据源');
      for(const k of ['enabled','authorized'])if(s[k]!==undefined&&typeof s[k]!=='boolean')fail('来源 enabled / authorized 须为布尔值，未知不会视为已授权');
      const out={id:s.id,name:text(s.name),type:s.type,enabled:s.enabled===true,authorized:s.authorized===true,authorization_note:text(s.authorization_note,2000),interval_minutes:numeric(s.interval_minutes||60,'同步周期',15,10080,true),token_env:'',path:'',url:''};
      if(out.enabled&&(!out.authorized||out.authorization_note.length<5))fail('启用前须确认使用权限并填写至少5个字符的依据');
      if(out.type==='json_file'){if(typeof s.path!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(s.path))fail('本地文件名须为1—80位字母数字、横杠或下划线组成的 .json 文件名');out.path=s.path;}else out.url=remoteURL(s.url);
      return out;
    });
  }
  async function fetchText(url,remote=false){
    const controller=typeof AbortController!=='undefined'?new AbortController():null;
    const timeout=controller?setTimeout(()=>controller.abort(),15000):null;
    try {
      const response=await root.fetch(url,{cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json'},...(controller?{signal:controller.signal}:{}),...(remote?{mode:'cors'}:{})});
      if(!response.ok)fail('数据源返回 HTTP '+response.status);
      if(remote&&!String(response.headers.get('Content-Type')||'').toLowerCase().includes('json'))fail('远程源未返回 JSON，请核对登录页、验证码或来源配置');
      const declared=Number(response.headers&&response.headers.get('Content-Length')||0);if(declared>MAX_BYTES)fail('单次数据源响应超过2MB');
      if(response.body&&typeof response.body.getReader==='function'){
        const reader=response.body.getReader(),decoder=new TextDecoder(),chunks=[];let bytes=0;
        try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();fail('单次数据源响应超过2MB');}chunks.push(decoder.decode(value,{stream:true}));}chunks.push(decoder.decode());return chunks.join('');}finally{reader.releaseLock();}
      }
      const result=await response.text();if(size(result)>MAX_BYTES)fail('单次数据源响应超过2MB');return result;
    }catch(e){if(e.name==='AbortError')fail('同步超过15秒，请检查来源');if(e instanceof TypeError)fail('无法读取数据源；远程源须允许 CORS 且无需登录，浏览器不会绕过限制');throw e;}
    finally{if(timeout!==null)clearTimeout(timeout);}
  }
  function sourceResult(d,id,rows,result){
    const times=rows.map(x=>x.observed_at),stale=rows.filter(x=>Date.now()-Date.parse(x.observed_at)>d.settings.stale_hours*3600000).length,warnings=[];
    if(!rows.length)warnings.push('来源成功返回空数据；不代表市场没有房源，不自动下架历史记录');
    if(stale)warnings.push(stale+'/'+rows.length+'条原始观测已过期；重复下载不会刷新核验时间');
    if(result.older_ignored)warnings.push(result.older_ignored+'条旧观测未覆盖已有记录');if(result.conflicts)warnings.push(result.conflicts+'条同时间内容冲突，需人工核对');
    if(rows.some(x=>x.data_issues.length))warnings.push('源中包含未解决的信息问题；请查看房源详情');
    warnings.push('浏览器只在主动同步时读取；页面关闭后不采集、不发送提醒');
    d.source_health[id]={last_attempt:now(),last_success:now(),failures:0,paused:false,result:clone(result),error:null,row_count:rows.length,stale_rows_at_sync:stale,newest_observed_at:times.sort().at(-1)||null,warnings,next_run:null};
  }
  function publicMetadata(payload){
    const out={schema_version:1,generated_at:null,monitor_until:null,sources:[],source_health:{},research:{run_id:null,data_commit_sha:null,completed_at:null,last_success_at:null,source_results:[],query_count:null},monitoring:{state:'unknown',reason:'公开数据未提供采集运行状态；读取成功不代表持续采集'}};
    if(!object(payload))return out;
    out.schema_version=payload.schema_version===2?2:1;
    if(object(payload.research)){const r=payload.research;out.research={run_id:text(r.run_id,160)||null,status:['success','partial','failed'].includes(r.status)?r.status:'unknown',data_commit_sha:/^[a-f0-9]{40}$/i.test(r.data_commit_sha||'')?r.data_commit_sha:null,completed_at:r.completed_at?recordTime(r.completed_at):null,last_success_at:r.last_success_at?recordTime(r.last_success_at):null,source_results:Array.isArray(r.source_results)?r.source_results.slice(0,100).filter(object).map(x=>({source_id:text(x.source_id||x.source,100),source_domain:text(x.source_domain,160),status:text(x.status||x.state,80),reason:text(x.reason,500),error:text(x.error,500)||null,retrieved_at:x.retrieved_at?recordTime(x.retrieved_at):null})):[],query_count:Number.isInteger(r.query_count)&&r.query_count>=0?r.query_count:null};}
    if(payload.generated_at)out.generated_at=time(payload.generated_at);
    if(payload.monitor_until){if(typeof payload.monitor_until!=='string'||!/^\d{4}-\d\d-\d\d$/.test(payload.monitor_until))fail('公开数据观察截止日期不正确');time(payload.monitor_until+'T00:00:00Z');out.monitor_until=payload.monitor_until;}
    if(object(payload.monitoring))out.monitoring={state:text(payload.monitoring.state,100)||'unknown',reason:text(payload.monitoring.reason,1000)};
    if(payload.sources!==undefined){if(!Array.isArray(payload.sources)||payload.sources.length>30)fail('公开数据源信息不合法');const ids=new Set();for(const s of payload.sources){if(!object(s)||typeof s.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(s.id)||['constructor','prototype'].includes(s.id)||ids.has(s.id))fail('公开数据源 ID 不合法');ids.add(s.id);out.sources.push({id:s.id,name:text(s.name),type:text(s.type,50),enabled:s.enabled===true,authorized:s.authorized===true,interval_minutes:Number.isInteger(s.interval_minutes)&&s.interval_minutes>0?s.interval_minutes:null});}}
    if(object(payload.source_health))for(const s of out.sources){const h=payload.source_health[s.id];if(!object(h))continue;const safe={last_attempt:h.last_attempt?time(h.last_attempt):null,last_success:h.last_success?time(h.last_success):null,newest_observed_at:h.newest_observed_at?time(h.newest_observed_at):null,error:h.error?text(h.error,500):null,warnings:Array.isArray(h.warnings)?h.warnings.filter(x=>typeof x==='string').slice(0,20).map(x=>text(x,500)):[],failures:Number.isInteger(h.failures)&&h.failures>=0?h.failures:0,row_count:Number.isInteger(h.row_count)&&h.row_count>=0?h.row_count:null};out.source_health[s.id]=safe;}
    return out;
  }
  function importPublic(d,raw,baseline=false){
    if(typeof raw!=='string'||size(raw)>MAX_BYTES)fail('公开数据不能超过2MB');let payload;try{payload=JSON.parse(raw.replace(/^\uFEFF/,''));}catch{fail('公开数据 JSON 格式不正确');}
    if(!object(payload)||payload.schema_version!==undefined&&![1,2].includes(payload.schema_version))fail('公开数据 schema_version 不兼容');
    const metadata=publicMetadata(payload),rows=decode(JSON.stringify({schema_version:1,listings:payload.listings}),'json',true);
    const incoming=payload.schema_version===2?payload.leads:[];if(!Array.isArray(incoming)||incoming.length>1000)fail('公开线索须为最多1000条的数组');
    const normalized=incoming.map(normalizeLead),ids=new Set();for(const lead of normalized){if(ids.has(lead.lead_id))fail('同一批次公开线索 ID 重复');ids.add(lead.lead_id);}
    if(metadata.generated_at&&d.public_feed.generated_at&&Date.parse(metadata.generated_at)<Date.parse(d.public_feed.generated_at))return {new:0,changed:0,unchanged:0,older_ignored:rows.length,conflicts:0,ids:[],leads_older_ignored:normalized.length,message:'忽略较旧的公开快照，原有线索与笔记未覆盖'};
    const result=importRows(d,rows,true,baseline);result.leads_new=0;result.leads_changed=0;result.leads_older_ignored=0;result.leads_conflicts=0;
    // Feed absence records only batch membership; it is never a withdrawal or a sale.
    if(payload.schema_version===2)for(const entry of d.leads)entry.in_latest_feed=ids.has(entry.lead_id);
    for(const lead of normalized){let entry=d.leads.find(x=>x.lead_id===lead.lead_id);
      if(!entry){entry={lead_id:lead.lead_id,data:lead,history:[clone(lead)],conflicts:[],in_latest_feed:true};d.leads.push(entry);result.leads_new++;continue;}
      if(entry.data.source_url!==lead.source_url||entry.data.source_item_id!==lead.source_item_id){fail('公开线索身份发生变化；同一 ID 不能改指其他来源');}
      const delta=Date.parse(lead.retrieved_at)-Date.parse(entry.data.retrieved_at);if(delta<0){result.leads_older_ignored++;continue;}
      if(delta===0&&JSON.stringify(lead)!==JSON.stringify(entry.data)){if(!entry.conflicts.some(x=>JSON.stringify(x)===JSON.stringify(lead)))entry.conflicts.push(clone(lead));entry.conflicts=entry.conflicts.slice(-20);result.leads_conflicts++;continue;}
      if(delta>0){entry.data=lead;entry.history.push(clone(lead));entry.history=entry.history.slice(-20);entry.conflicts=[];result.leads_changed++;}
      entry.in_latest_feed=true;
    }
    d.public_feed=metadata;sourceResult(d,'_public_feed',rows,result);return result;
  }
  async function poll(d,body){
    if(body.source_id&&!d.sources.some(x=>x.id===body.source_id))fail('指定的数据源不存在');const results=[];
    for(const s of d.sources){if(body.source_id&&s.id!==body.source_id||!s.enabled||!s.authorized)continue;
      try{const raw=s.type==='json_file'?(d.inbox[s.path]||fail('浏览器收件箱没有该文件，请先上传')):await fetchText(s.url,true);const rows=decode(raw,'json',true),result=importRows(d,rows,true);sourceResult(d,s.id,rows,result);results.push({id:s.id,...result});}
      catch(e){const old=d.source_health[s.id]||{},failures=(old.failures||0)+1;const message=s.type==='json_https'?'远程同步失败：请检查网络、CORS、授权和 JSON 格式。失败不会刷新观测或下架房源。':'本地同步失败：'+e.message;d.source_health[s.id]={...old,last_attempt:now(),failures,paused:false,error:message,next_run:null};results.push({id:s.id,error:message,paused:false});}
    }
    return {sources:results,active_count:0,message:'仅执行本次手动同步；没有后台采集任务'};
  }
  function persist(candidate){
    const serialized=JSON.stringify(candidate);
    let current;try{current=root.localStorage.getItem(KEY);}catch{fail('浏览器禁止读取本地存储；本次修改未保存。');}
    if(current!==savedValue)fail('其他页面已修改或清除了浏览器数据；本次修改未保存。请先刷新记录，再重新保存，避免覆盖另一页的笔记。');
    try{root.localStorage.setItem(KEY,serialized);}catch{fail('浏览器存储写入失败或空间不足；本次修改未保存。请先下载备份并清理空间后重试。');}
    db=candidate;savedValue=serialized;
  }
  function refreshStorage(){let current;try{current=root.localStorage.getItem(KEY);}catch{fail('浏览器禁止读取本地存储，请允许此站点存储后重试。');}if(current===savedValue)return;if(!current)fail('浏览器数据已被其他页面清除；请重新加载页面后再操作。');let updated;try{updated=validateBackup(JSON.parse(current));}catch(e){fail('其他页面的浏览器数据无法读取，未覆盖现有记录：'+e.message);}db=updated;savedValue=current;}
  function empty(){return {schema_version:SCHEMA,sequence:0,settings:settings(bootstrap.settings||{}),offers:[],user:{},snapshots:[],alerts:[],audit:[],sources:[],inbox:{},source_health:{},leads:[],lead_user:{},public_feed:publicMetadata(null)};}
  function validateBackup(input){
    if(!object(input)||input.schema_version!==SCHEMA)fail('备份格式或版本不兼容');
    const p=input.browser_backup===true?input.data:input;if(!object(p)||p.schema_version!==SCHEMA)fail('请选择本系统的浏览器 JSON 备份；房源导出文件不包含核验和笔记');
    const out=empty();out.settings=settings(p.settings||{});out.sources=sources(p.sources||[]);out.public_feed=publicMetadata(p.public_feed);
    if(p.leads!==undefined){if(!Array.isArray(p.leads)||p.leads.length>10000)fail('备份公开线索数量不合法');const ids=new Set();for(const entry of p.leads){if(!object(entry)||typeof entry.in_latest_feed!=='boolean'||!Array.isArray(entry.history)||!Array.isArray(entry.conflicts)||entry.history.length>20||entry.conflicts.length>20)fail('备份公开线索结构不合法');const data=normalizeLead(entry.data),id=leadId(entry.lead_id);if(id!==data.lead_id||ids.has(id))fail('备份公开线索身份不一致或重复');ids.add(id);const check=x=>{const item=normalizeLead(x);if(item.lead_id!==id||item.source_url!==data.source_url||item.source_item_id!==data.source_item_id)fail('备份公开线索历史身份不一致');return item;};out.leads.push({lead_id:id,data,history:entry.history.map(check),conflicts:entry.conflicts.map(check),in_latest_feed:entry.in_latest_feed});}}
    if(p.lead_user!==undefined){if(!object(p.lead_user))fail('备份线索笔记结构不正确');for(const [id,u] of Object.entries(p.lead_user)){leadId(id);if(!out.leads.some(x=>x.lead_id===id)||!object(u)||typeof u.saved!=='boolean'||typeof u.notes!=='string')fail('备份线索笔记关联不正确');out.lead_user[id]={saved:u.saved,notes:text(u.notes,16000),updated_at:u.updated_at?recordTime(u.updated_at):null};}}
    for(const k of ['offers','snapshots','alerts','audit'])if(!Array.isArray(p[k]))fail('备份缺少 '+k+' 数组');
    if(p.offers.length>10000||p.snapshots.length>50000||p.alerts.length>50000||p.audit.length>50000||!object(p.user)||!object(p.inbox)||!object(p.source_health))fail('备份结构或记录数量不合法');
    const ids=new Set(),keys=new Set();
    for(const raw of p.offers){if(!object(raw)||typeof raw.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(raw.id)||['constructor','prototype','__proto__'].includes(raw.id)||ids.has(raw.id))fail('备份房源 ID 不合法或重复');const data=normalize(raw.data,true),key=identity(data);if(keys.has(key))fail('备份来源身份重复');ids.add(raw.id);keys.add(key);
      const first_seen=recordTime(raw.first_seen),last_seen=recordTime(raw.last_seen);if(last_seen!==data.observed_at)fail('备份最新观测时间不一致');out.offers.push({id:raw.id,identity:key,data,first_seen,last_seen});
      const u=p.user[raw.id];if(!object(u)||!STAGES.includes(u.stage)||!object(u.checks))fail('备份跟进状态不合法');const user={stage:u.stage,notes:text(u.notes,16000),group_id:text(u.group_id,100),checks:{}};
      for(const [cid,c] of Object.entries(u.checks)){const spec=bootstrap.knowledge.checks.find(x=>x.id===cid);if(!spec||!object(c)||!CHECK_STATUS.includes(c.status))fail('备份核验项不合法');const evidence=text(c.evidence,8000);if(['通过','不适用','有风险'].includes(c.status)&&evidence.length<5)fail('备份通过/风险核验必须含具体依据');if(c.status==='不适用'&&(!spec.allow_na||cid==='newhome'&&data.housing_type==='精装现房'))fail('备份含不允许跳过的必要核验');user.checks[cid]={status:c.status,evidence,updated_at:recordTime(c.updated_at)};}
      out.user[raw.id]=user;
    }
    const recordIds=new Set(),seq=value=>{const n=numeric(value,'记录编号',1,Number.MAX_SAFE_INTEGER-100000,true);if(recordIds.has(n))fail('备份记录编号重复');recordIds.add(n);out.sequence=Math.max(out.sequence,n);return n;};
    out.sequence=numeric(p.sequence||0,'备份计数',0,Number.MAX_SAFE_INTEGER-100000,true);
    for(const h of p.snapshots){if(!object(h)||!ids.has(h.offer_id))fail('备份快照关联房源不存在');const data=normalize(h.data,true),related=out.offers.find(x=>x.id===h.offer_id);if(identity(data)!==related.identity||time(h.observed_at)!==data.observed_at)fail('备份快照来源身份或时间不一致');out.snapshots.push({id:seq(h.id),offer_id:h.offer_id,observed_at:data.observed_at,captured_at:recordTime(h.captured_at),data});}
    for(const a of p.alerts){if(!object(a)||a.offer_id!==null&&!ids.has(a.offer_id))fail('备份提醒关联房源不正确');out.alerts.push({id:seq(a.id),offer_id:a.offer_id,kind:text(a.kind),message:text(a.message,4000),created_at:recordTime(a.created_at),read_at:a.read_at?recordTime(a.read_at):null,confirmation:text(a.confirmation,4000)});}
    for(const a of p.audit){if(!object(a)||!ids.has(a.offer_id))fail('备份操作记录关联房源不正确');out.audit.push({id:seq(a.id),offer_id:a.offer_id,action:text(a.action),detail:text(a.detail,20000),created_at:recordTime(a.created_at)});}
    for(const [filename,inputText] of Object.entries(p.inbox)){if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(filename))fail('备份收件箱文件名不合法');const rows=decode(inputText,'json',true);out.inbox[filename]=JSON.stringify({schema_version:1,listings:rows});}
    // Health is display-only. Rebuild a bounded whitelist instead of trusting arbitrary backup keys.
    for(const sid of [...out.sources.map(x=>x.id),'_public_feed']){const h=p.source_health[sid];if(!object(h))continue;const safe={last_attempt:h.last_attempt?recordTime(h.last_attempt):null,last_success:h.last_success?recordTime(h.last_success):null,newest_observed_at:h.newest_observed_at?recordTime(h.newest_observed_at):null,error:h.error?text(h.error,500):null,warnings:Array.isArray(h.warnings)?h.warnings.filter(x=>typeof x==='string').slice(0,20).map(x=>text(x,500)):[],next_run:null,failures:Number.isInteger(h.failures)&&h.failures>=0?h.failures:0,paused:false};
      for(const k of ['row_count','stale_rows_at_sync'])if(own(h,k))safe[k]=numeric(h[k],'来源记录数量',0,10000,true);
      if(object(h.result)){safe.result={};for(const k of ['new','changed','unchanged','older_ignored','conflicts'])safe.result[k]=numeric(h.result[k]||0,'同步结果数量',0,10000,true);safe.result.ids=Array.isArray(h.result.ids)?h.result.ids.filter(x=>ids.has(x)).slice(0,1000):[];}out.source_health[sid]=safe;}
    return out;
  }
  async function init(){
    let raw;try{raw=await fetchText(new URL('data/pages-bootstrap.json',root.document?root.document.baseURI:root.location.href).href);}catch{fail('无法读取 GitHub Pages 初始化资料；请确认已部署 data/pages-bootstrap.json。');}
    try{bootstrap=JSON.parse(raw);}catch{fail('初始化资料 JSON 格式不正确');}
    if(!object(bootstrap)||!object(bootstrap.knowledge)||!Array.isArray(bootstrap.knowledge.checks)||!Array.isArray(bootstrap.knowledge.policies)||!Array.isArray(bootstrap.knowledge.channels)||!bootstrap.knowledge.checks.length)fail('初始化知识资料不完整');
    const checkIds=new Set();for(const c of bootstrap.knowledge.checks){if(!object(c)||typeof c.id!=='string'||!/^[a-z][a-z0-9_-]{0,79}$/.test(c.id)||checkIds.has(c.id))fail('初始化核验项不合法');checkIds.add(c.id);}
    let stored;try{stored=root.localStorage.getItem(KEY);}catch{fail('浏览器禁止读取本地存储；请允许此站点存储后重试。');}savedValue=stored;
    if(stored){try{db=validateBackup(JSON.parse(stored));}catch(e){fail('现有浏览器数据无法读取，已保留原数据：'+e.message);}}
    else persist(empty());
    // Public same-origin feed contains only intentionally published observations.
    // Its absence is normal; this never polls portals or configured remote sources.
    try{const payload=await fetchText(new URL('data/public-feed.json',root.document?root.document.baseURI:root.location.href).href),candidate=clone(db);importPublic(candidate,payload,!stored);persist(candidate);}catch(e){feedReadError='公开观察数据未读取：'+e.message;}
  }
  function ready(){return initialized||(initialized=init());}
  function csvExport(){const fields=['id','source','source_item_id','url','community','district','price_yuan','area_m2','rooms','bathrooms',...BOOLS,'status','observed_at','stage','notes'];const cell=v=>{let s=v===null||v===undefined?'':String(v);if(/^[=+\-@\t\r]/.test(s))s="'"+s;return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};return '\uFEFF'+[fields.join(','),...list(db).map(x=>fields.map(k=>cell(x[k])).join(','))].join('\r\n')+'\r\n';}
  function digest(){const day=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),offers=list(db),events=db.alerts.filter(x=>Date.now()-Date.parse(x.created_at)<=86400000),lines=['# 吉安购房观察｜'+day,'','范围：吉州区、吉安县；排除井开区与青原区。','浏览器本地记录与公开观察数据；页面关闭后不采集、不通知。不是全网房源或成交行情。','',`当前 ${offers.length} 条线索；过去24小时 ${events.length} 条本地记录变更。`,'','## 新增与变化',...(events.length?events.slice(-20).reverse().map(x=>'- ['+x.kind+'] '+x.message):['无记录到的变化；不代表市场没有变化。']),'','## 优先核验'];
    for(const x of offers.filter(x=>!['不符合','非在售'].includes(x.assessment.status)&&x.stage!=='已放弃').slice(0,5))lines.push('- '+(x.community||x.title)+'｜'+(x.price_yuan===null?'报价未知':x.price_yuan/10000+'万元')+'｜'+x.assessment.status,'  下一步：'+[...x.data_issues,...x.assessment.critical,...x.assessment.pending,...x.assessment.unresolved].slice(0,3).join('；'),'  来源：'+(x.url||'手动记录')+'；原始观测：'+x.observed_at);
    lines.push('','## 数据与交易提醒','- '+offers.filter(x=>x.assessment.stale).length+' 条观测已过期，应重新核实。','- 未核实产权、贷款、停车和资金监管前，不因低价或催促直接支付定金。','- 浏览器记录请定期备份；本简报不构成估价、贷款承诺或法律审查结论。');return {body:lines.join('\n')};}
  function bodyOf(options,endpoint){if(!options||options.body===undefined)return {};let body=options.body;if(typeof body==='string'){const limit=endpoint==='/api/restore'?MAX_BACKUP_BYTES*2+64:MAX_BYTES*3;if(size(body)>limit)fail('请求正文过大');try{body=JSON.parse(body);}catch{fail('请求正文 JSON 格式不正确');}}if(!object(body))fail('请求正文须为对象');return body;}
  async function mutate(path,body){
    if(path==='/api/parse')return parse(body.text);if(path==='/api/calculate')return calculate(body);if(path==='/api/digest')return digest();
    let candidate=clone(db),result;
    if(path==='/api/import'){const rows=own(body,'rows')?body.rows:decode(body.text,body.format||'json');if(!Array.isArray(rows)||!rows.length)fail('没有可导入的房源');result=importRows(candidate,rows,!own(body,'rows'));}
    else if(path==='/api/observe'){const old=offer(candidate,body.id);if(!object(body.fields))fail('fields 须为对象');const data={...old,...body.fields,observed_at:body.fields.observed_at||now()};if(own(body.fields,'price_wan')&&!own(body.fields,'price_yuan'))data.price_yuan=money(body.fields.price_wan,10000);delete data.price_wan;const normalized=normalize(data);if(identity(normalized)!==identity(old))fail('更新不能改变房源身份，另一套房请新增记录');result=importRows(candidate,[normalized]);}
    else if(path==='/api/check'){const item=offer(candidate,body.id),spec=bootstrap.knowledge.checks.find(x=>x.id===body.check_id),evidence=text(body.evidence,8000);if(!spec||!CHECK_STATUS.includes(body.status))fail('检查项或状态不正确');if(['通过','不适用','有风险'].includes(body.status)&&evidence.length<5)fail('请记录具体核验依据或不适用原因，至少5个字符；不能只打勾');if(body.status==='不适用'&&(!spec.allow_na||spec.id==='newhome'&&item.housing_type==='精装现房'))fail('这是一项必要核验，不能标为不适用');candidate.user[item.id].checks[spec.id]={status:body.status,evidence,updated_at:now()};audit(candidate,item.id,'核验记录',spec.title+'：'+body.status+'；'+evidence);result={ok:true};}
    else if(path==='/api/workflow'){const item=offer(candidate,body.id),stage=own(body,'stage')?body.stage:item.stage;if(!STAGES.includes(stage))fail('流程阶段不正确');if(['付定金','待签约','贷款办理','过户交房','已完成'].includes(stage)&&stage!==item.stage){const a=item.assessment,problems=[...a.unresolved,...a.failures,...a.pending,...a.critical];if(['付定金','待签约','贷款办理'].includes(stage)&&item.status!=='已确认在售')problems.push('需确认当前在售状态');if(item.status==='已下架')problems.push('房源已下架，需核实实际交易情况');if(item.data_issues.length)problems.push('来源存在信息冲突，请先复核并更新房源');if(a.stale)problems.push('房源观测已过期，请重新核实在售状态');if(problems.length)fail('系统流程提醒：关键核验尚未完成，暂不能推进。'+problems.slice(0,6).join('；'));if(stage==='已完成'&&!cleared(item.checks.find(x=>x.id==='delivery')||{}))fail('交房交接核验尚未完成');}const u=candidate.user[item.id];u.stage=stage;if(own(body,'notes'))u.notes=String(body.notes||'').slice(0,16000);if(own(body,'group_id'))u.group_id=text(body.group_id,100);audit(candidate,item.id,'流程/笔记',JSON.stringify({stage:u.stage,notes:u.notes,group_id:u.group_id}));result={ok:true};}
    else if(path==='/api/alert'){const a=candidate.alerts.find(x=>x.id===Number(body.id)),confirmation=text(body.confirmation,4000);if(!a)fail('提醒不存在');if(confirmation&&confirmation.length<5)fail('确认依据至少5个字符');a.read_at=now();if(confirmation)a.confirmation=confirmation;result={ok:true};}
    else if(path==='/api/lead-followup'){const id=leadId(body.lead_id);if(!candidate.leads.some(x=>x.lead_id===id))fail('公开线索不存在');const prev=candidate.lead_user[id]||{saved:false,notes:'',updated_at:null};if(own(body,'saved')&&typeof body.saved!=='boolean'||own(body,'notes')&&typeof body.notes!=='string')fail('关注须为布尔值，笔记须为文本');candidate.lead_user[id]={saved:own(body,'saved')?body.saved:prev.saved,notes:own(body,'notes')?text(body.notes,16000):prev.notes,updated_at:now()};result={ok:true};}
    else if(path==='/api/settings'){candidate.settings=settings(body,candidate.settings);result=clone(candidate.settings);}
    else if(path==='/api/sources'){candidate.sources=sources(body.sources);result=clone(candidate.sources);}
    else if(path==='/api/inbox'){if(typeof body.filename!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(body.filename))fail('文件名须为英文字母/数字/横杠/下划线组成的 .json 文件名，不得含路径');const rows=decode(body.text,body.format||'json',true);if(own(candidate.inbox,body.filename)&&body.overwrite!==true)fail('同名文件已存在；确认替换后再勾选覆盖');const payload=JSON.stringify({schema_version:1,listings:rows});if(size(payload)>MAX_BYTES)fail('标准化后的文件超过2MB，请拆分');candidate.inbox[body.filename]=payload;result={filename:body.filename,row_count:rows.length,message:'文件仅保存在当前浏览器，配置来源并主动同步后才会导入。原始观测时间未改写。'};}
    else if(path==='/api/poll')result=await poll(candidate,body);
    else if(path==='/api/sync-public'){const raw=await fetchText(new URL('data/public-feed.json',root.document?root.document.baseURI:root.location.href).href);result=importPublic(candidate,raw);}
    else if(path==='/api/restore'){let data=body.backup;if(typeof body.text==='string'){if(size(body.text)>MAX_BACKUP_BYTES)fail('备份文件超过6MB');try{data=JSON.parse(body.text);}catch{fail('备份 JSON 格式不正确');}}else if(data!==undefined&&size(JSON.stringify(data))>MAX_BACKUP_BYTES)fail('备份文件超过6MB');candidate=validateBackup(data);result={ok:true,restored:candidate.offers.length};}
    else fail('浏览器模式不支持此接口');
    persist(candidate);if(path==='/api/sync-public')feedReadError=null;return result;
  }
  async function request(path,options={}){
    await ready();const url=new URL(path,root.location.href),method=(options.method||'GET').toUpperCase();
    if(url.origin!==new URL(root.location.href).origin)fail('接口路径必须属于当前站点');
    const endpoint=url.pathname.replace(/^.*(?=\/api\/)/,'');
    if(method==='POST'){const operation=queue.then(()=>mutate(endpoint,bodyOf(options,endpoint))).then(clone);queue=operation.catch(()=>{});return operation;}
    if(method!=='GET')fail('仅支持 GET / POST');await queue;refreshStorage();
    if(endpoint==='/api/state')return clone(state());if(endpoint.startsWith('/api/offer/'))return clone(offer(db,decodeURIComponent(endpoint.slice('/api/offer/'.length))));
    if(endpoint.startsWith('/api/lead/'))return clone(leadDetail(db,decodeURIComponent(endpoint.slice('/api/lead/'.length))));
    if(endpoint==='/api/digest')return digest();
    if(endpoint==='/api/export')return url.searchParams.get('format')==='csv'?csvExport():{schema_version:1,exported_at:now(),listings:list(db)};
    if(endpoint==='/api/backup')return {schema_version:SCHEMA,browser_backup:true,exported_at:now(),data:clone(db)};
    fail('浏览器模式不支持此接口');
  }
  async function download(path){const data=await request(path),csv=typeof data==='string',backup=path.includes('/api/backup'),name=backup?'homewatch-browser-backup.json':csv?'homewatch-listings.csv':'homewatch-listings.json',blob=new Blob([csv?data:JSON.stringify(data,null,2)],{type:csv?'text/csv;charset=utf-8':'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=root.document.createElement('a');a.href=url;a.download=name;root.document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);return {filename:name};}
  root.HomeWatchBrowser=Object.freeze({request,download,restore:input=>request('/api/restore',{method:'POST',body:{text:input}}),syncPublicFeed:()=>request('/api/sync-public',{method:'POST',body:'{}'}),storageKey:KEY,maxBackupBytes:MAX_BACKUP_BYTES});
})(window);
