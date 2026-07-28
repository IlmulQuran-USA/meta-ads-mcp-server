import { analyze, extractResults } from '../dist/analysis.js';
let pass = 0, failn = 0;
const t = (name, cond) => { cond ? pass++ : (failn++, console.log('FAIL:', name)); };

// --- extractResults: prefers aggregate 'lead', no double counting ---
t('aggregate lead preferred', extractResults([
  {action_type:'lead', value:'10'},
  {action_type:'offsite_conversion.fb_pixel_lead', value:'7'},
  {action_type:'onsite_conversion.lead_grouped', value:'3'},
], 'lead') === 10);
t('fallback sums channels', extractResults([
  {action_type:'offsite_conversion.fb_pixel_lead', value:'7'},
  {action_type:'onsite_conversion.lead_grouped', value:'3'},
], 'lead') === 10);
t('empty actions -> 0', extractResults(undefined, 'lead') === 0);
t('unrelated actions -> 0', extractResults([{action_type:'link_click', value:'50'}], 'lead') === 0);

// --- analyze: fixture with one of each expected verdict ---
const mk = (id, name, spend, imp, clicks, ctr, freq, leads) => ({
  adset_id: id, adset_name: name, spend: String(spend), impressions: String(imp),
  clicks: String(clicks), ctr: String(ctr), cpm: '8', frequency: String(freq),
  actions: leads > 0 ? [{action_type:'lead', value:String(leads)}] : [],
});
// medians: CPLs present -> winner 2.0, healthy 5.0, under 8.0, big 5.0... let's construct:
// winner: 20/10=2, healthy: 25/5=5, under: 40/5=8, fatigued freq 4: 30/6=5, loser: 60 spend 0 leads
// median of [2,5,8,5] = 5. under 8 > 1.3*5=6.5 ✓; winner 2 <= 3.5 (0.7*5) ✓; loser zero ✓
const curr = [
  mk('a1','Winner', 20, 9000, 300, 3.2, 2.1, 10),
  mk('a2','Healthy', 25, 8000, 200, 2.5, 2.0, 5),
  mk('a3','Under', 40, 9000, 150, 1.6, 2.2, 5),
  mk('a4','TiredCreative', 30, 7000, 100, 1.4, 4.2, 6),
  mk('a5','BigLoser', 60, 20000, 400, 2.0, 2.5, 0),
  mk('a6','Newbie', 2, 300, 10, 3.0, 1.1, 0),
];
// prev window: TiredCreative had ctr 2.8 (drop to 1.4 = -50%); Winner similar
const prev = [
  mk('a1','Winner', 18, 8500, 280, 3.3, 1.9, 9),
  mk('a4','TiredCreative', 28, 6800, 190, 2.8, 3.0, 7),
];
const res = analyze(curr, prev, {goal_action:'lead', level:'adset', window:'test', min_spend:5, currency:'USD'});
const v = Object.fromEntries(res.entities.map(e=>[e.name, e.verdict]));
t('Winner -> SCALE_CANDIDATE', v['Winner']==='SCALE_CANDIDATE');
t('Healthy -> HEALTHY', v['Healthy']==='HEALTHY');
t('Under -> UNDERPERFORMING', v['Under']==='UNDERPERFORMING');
t('Tired -> FATIGUED', v['TiredCreative']==='FATIGUED');
t('BigLoser -> LOSING', v['BigLoser']==='LOSING');
t('Newbie -> INSUFFICIENT_DATA', v['Newbie']==='INSUFFICIENT_DATA');
t('median CPL = 5', res.totals.median_cost_per_result === 5);
t('totals spend', Math.abs(res.totals.spend - 177) < 0.01);
t('LOSING sorted first', res.entities[0].verdict==='LOSING');
const winner = res.entities.find(e=>e.name==='Winner');
t('trend attached', !!winner.trend && winner.trend.prev_results===9);
t('rec mentions 20-30%', winner.recommendation.includes('20-30%'));

// zero-results account warning
const res2 = analyze([mk('x','OnlyAd', 50, 10000, 200, 2.0, 2.0, 0)], null,
  {goal_action:'lead', level:'adset', window:'t', min_spend:5, currency:'USD'});
t('pixel warning on zero results', res2.summary.some(s=>s.includes('WARNING')));

// >2x median CPL -> LOSING
const res3 = analyze([
  mk('m1','Cheap', 10, 5000, 100, 2, 2, 5),   // CPL 2
  mk('m2','Cheap2', 12, 5000, 100, 2, 2, 6),  // CPL 2
  mk('m3','Expensive', 50, 9000, 100, 1, 2, 5), // CPL 10 > 2x median(2)
], null, {goal_action:'lead', level:'adset', window:'t', min_spend:5, currency:'USD'});
t('>2x median -> LOSING', res3.entities.find(e=>e.name==='Expensive').verdict==='LOSING');

console.log(`\n${pass} passed, ${failn} failed`);
process.exit(failn ? 1 : 0);
