/* The Lab's game simulation engine, shared by the Game Simulations page (sim-player.html) and the site build
   (scripts/sim-parlays.ts, which runs the same 5,000 games to price each game's Sim Parlay). Plain script: it reads the
   page's DATA (data/sims/games.json) and defines its functions as globals. Every run is seeded, so the page and the
   build see the very same games. */

function rng(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function pick(r,items,w){let s=0;for(const x of w)s+=x;let u=r()*s;for(let i=0;i<items.length;i++){u-=w[i];if(u<=0)return items[i]}return items[items.length-1]}
const SUFFIX=/^(jr\.?|sr\.?|ii|iii|iv)$/i;
const short=n=>{const p=n.split(' ');return p[0][0]+'. '+p.slice(1).join(' ')};
const inits=n=>{const p=n.split(' ').filter(w=>!SUFFIX.test(w));return (p[0][0]+(p.length>1?p[p.length-1][0]:'')).toUpperCase()};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const median=a=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1]};

/* ================= NBA engine ================= */
let NBA=null;
function setupNBA(){
  const hi=(NBA.book.total+NBA.book.spread)/2, lo=(NBA.book.total-NBA.book.spread)/2, tgt=NBA.book.fav?[lo,hi]:[hi,lo];
  NBA.teams.forEach((T,ti)=>{
    const rows=DATA.nba.players[T.abbr]; const tot=rows.reduce((s,r)=>s+r.min,0); const k=240/tot;
    // the team scores what its own players project for, the same numbers the picks use; the book's line is shown beside
    // it for comparison, never forced on the players
    T.target=rows.reduce((s,r)=>s+r.pts,0); T.book=tgt[ti]; T.pa=0.6; T.pr=1;
    T.ps=rows.map(r=>({...r,short:r.bench?'Reserves':short(r.name),ini:r.bench?'RS':inits(r.name),m:r.min*k,
      w3:r.tpm/r.min+0.002, w2:Math.max(0.02,(r.pts-3*r.tpm)/r.min), wf:r.pts/r.min+0.01, wr:r.reb/r.min+0.01, wa:r.ast/r.min+0.005}));
    // rotation: 16 stints of 3 minutes; starters open each half and close the game
    const rem=T.ps.map(p=>p.m), rot=[];
    for(let s=0;s<16;s++){
      const lu=[0,8,15].includes(s)?[0,1,2,3,4]:T.ps.map((_,i)=>i).sort((a,b)=>rem[b]-rem[a]).slice(0,5);
      lu.forEach(i=>rem[i]-=3); rot.push(lu);
    }
    T.rot=rot;
    const t3=rows.reduce((s,r)=>s+r.tpm*k,0)*T.target/rows.reduce((s,r)=>s+r.pts*k,0);
    T.a3=clamp(t3/(100*0.79*0.36),0.25,0.55); T.p2=0.53;
  });
  calibrateNBA();
}
// Tunes the engine until every player's average over the runs matches his projection: team rates (2-point makes, three
// rate, assisted makes, rebounds credited to a player) set the team totals, and each player's shot, rebound and assist
// weights set his share. The 5,000 runs then center on the same projections the picks are made from.
function calibrateNBA(){
  const T=NBA.teams, N=250, f=(want,got)=>Math.pow(Math.max(want,0.05)/Math.max(got,0.05),0.7);
  for(let it=0;it<6;it++){
    const box=T.map(t=>t.ps.map(()=>({pts:0,reb:0,ast:0,tpm:0}))), sc=[0,0];
    for(let s=0;s<N;s++){const g=simNBA(9000+s,true);sc[0]+=g.score[0];sc[1]+=g.score[1];
      for(const e of g.ev)for(const [ti,p,k,v] of e.bx)box[ti][p][k]+=v/N}
    T.forEach((t,ti)=>{const b=box[ti], got=k=>b.reduce((s,x)=>s+x[k],0), want=k=>t.ps.reduce((s,p)=>s+p[k],0);
      t.a3=clamp(t.a3*f(want('tpm'),got('tpm')),0.15,0.6);
      t.p2=clamp(t.p2+(t.target-sc[ti]/N)/(2*100*0.79*(1-t.a3)*1.15),0.35,0.75);
      t.pa=clamp(t.pa*f(want('ast'),got('ast')),0.3,0.85);
      t.pr=clamp(t.pr*f(want('reb'),got('reb')),0.6,1);
      t.ps.forEach((p,i)=>{const x=b[i], two=f(p.pts-3*p.tpm,x.pts-3*x.tpm);
        p.w3*=f(p.tpm,x.tpm); p.w2*=two; p.wf*=two; p.wa*=f(p.ast,x.ast); p.wr*=f(p.reb,x.reb)});
    });
  }
}
function nbaPeriod(t){return t<2880?Math.min(3,Math.floor(t/720)):4+Math.floor((t-2880)/300)}
function nbaLeft(t){const q=nbaPeriod(t);return q<4?720*(q+1)-t:2880+300*(q-3)-t}
function shotSpot(r,kind){
  if(kind===3){const th=(r()*2-1)*1.3, R=23.9+r()*2.2;return [clamp(5.25+Math.cos(th)*R,1.5,40),clamp(25+Math.sin(th)*R,2.2,47.8)]}
  if(r()<0.55){const th=(r()*2-1)*1.5,R=1+r()*5;return [5.25+Math.cos(th)*R,25+Math.sin(th)*R]}
  const th=(r()*2-1)*1.35,R=8+r()*12;return [5.25+Math.cos(th)*R,25+Math.sin(th)*R];
}
function simNBA(seed,rec){
  const r=rng(seed), T=NBA.teams, score=[0,0], ev=[], line=[[],[]];
  let t=0, off=r()<0.5?0:1;
  const add=(e)=>{if(rec){e.score=[...score];ev.push(e)}};
  const bump=(ti,q,p)=>{line[ti][q]=(line[ti][q]||0)+p};
  while(true){
    const qEnd=t<2880?720*(Math.floor(t/720)+1):2880+300*(Math.floor((t-2880)/300)+1);
    const seg=Math.min(15,Math.floor(t/180)), o=T[off], d=T[1-off], on=o.rot[seg], dn=d.rot[seg];
    let tt=t+6+r()*12.5, live=true;
    while(live){
      tt=Math.min(tt,qEnd-0.3); const q=nbaPeriod(tt), u=r();
      if(u<0.125){const p=pick(r,on,on.map(i=>o.ps[i].wa+0.05));add({t:tt,off,type:'to',p,bx:[]});live=false}
      else if(u<0.245){const p=pick(r,on,on.map(i=>o.ps[i].wf));let m=0;for(let k=0;k<2;k++)if(r()<0.78)m++;
        score[off]+=m;bump(off,q,m);add({t:tt,off,type:'ft',p,made:m,bx:[[off,p,'pts',m]]});live=false}
      else{
        const three=r()<o.a3, p=pick(r,on,on.map(i=>three?o.ps[i].w3:o.ps[i].w2)), spot=shotSpot(r,three?3:2);
        const dist=spot?Math.round(Math.hypot(spot[0]-5.25,spot[1]-25)):0;
        if(r()<(three?0.36:o.p2)){
          const pts=three?3:2; score[off]+=pts; bump(off,q,pts);
          let a=null; if(r()<o.pa){const mates=on.filter(i=>i!==p);a=pick(r,mates,mates.map(i=>o.ps[i].wa))}
          const bx=[[off,p,'pts',pts]]; if(three)bx.push([off,p,'tpm',1]); if(a!=null)bx.push([off,a,'ast',1]);
          add({t:tt,off,type:'made',kind:pts,p,a,spot,dist,bx}); live=false;
        }else{
          add({t:tt,off,type:'miss',kind:three?3:2,p,spot,dist,bx:[]});
          tt+=1.5;
          // a rebound no player is credited with (out of bounds, a tip) is a team rebound
          if(r()<0.24){const rb=pick(r,on,on.map(i=>o.ps[i].wr)), cr=r()<o.pr;add({t:tt,off,type:'reb',side:'off',p:rb,team:!cr,bx:cr?[[off,rb,'reb',1]]:[]});tt+=2+r()*6}
          else{const rb=pick(r,dn,dn.map(i=>d.ps[i].wr)), cr=r()<d.pr;add({t:tt,off:1-off,type:'reb',side:'def',p:rb,team:!cr,bx:cr?[[1-off,rb,'reb',1]]:[]});live=false}
        }
      }
    }
    // keep events inside their period
    t=Math.min(tt+0.5,qEnd);
    if(t>=qEnd&&qEnd>=2880&&(score[0]!==score[1]||qEnd>=2880+1500))break;
    off=1-off;
  }
  return {score,ev,line,seed,periods:Math.max(4,nbaPeriod(Math.max(0,t-0.01))+1)};
}

/* ================= NFL engine ================= */
let NFL=null;
// NFL.legacy (a replay already posted on X, sim-pins.json) keeps the engine those runs were made with: one yardage scale
// per team (k) tuned so the team scores its implied points. Otherwise calibrateNFL tunes each player to his projection.
function setupNFL(){
  NFL.teams.forEach(T=>{
    const src=NFL.src.teams[T.abbr]; T.target=src.implied; T.legacy=!!NFL.legacy;
    T.ps=src.players.map(p=>({...p,short:short(p.name),ini:inits(p.name)}));
    T.qb=T.ps.find(p=>p.attempts);
    T.rush=T.ps.filter(p=>(p.carries||0)>0.3); T.tgt=T.ps.filter(p=>(p.targets||0)>0.3);
    const ru=T.rush.reduce((s,p)=>s+p.carries,0), ry=T.rush.reduce((s,p)=>s+p.rush_yards,0);
    T.passRate=T.qb.attempts/(T.qb.attempts+ru); T.cmp=T.qb.completions/T.qb.attempts;
    T.ypr=ry/ru; T.intr=T.qb.interceptions/T.qb.attempts; T.k=1;
    T.tgt.forEach(p=>p.ypc=p.receptions>0.2?p.rec_yards/p.receptions:9);
    // each player's share of the carries and targets, and his own yards per carry and per catch
    T.rush.forEach(p=>{p.wc=p.carries;p.rr=p.rush_yards>0?p.rush_yards/p.carries:T.ypr});
    T.tgt.forEach(p=>{p.wt=p.targets;p.yc=p.ypc});
  });
  if(!NFL.legacy){calibrateNFL();return}
  for(let it=0;it<6;it++){
    const sum=[0,0]; for(let s=0;s<300;s++){const g=simNFL(7000+s,false);sum[0]+=g.score[0];sum[1]+=g.score[1]}
    NFL.teams.forEach((T,ti)=>{T.k=clamp(T.k*Math.pow(T.target/(sum[ti]/300),0.7),0.5,1.8)});
  }
}
// Tunes the engine until every player's average over the runs matches his projection, as calibrateNBA does: the team's
// pace (plays a game), pass rate and completion rate match its QB's attempts and completions, each player's carry and target shares his
// carries and catches, his yards per carry and per catch his yards. Yards are then the projections' own, so the team's
// implied points come from how well drives finish (cv: a third or fourth down play that comes up short still converts),
// not from inflating every gain, which ran rushing yards about 6 and QB passing yards about 17 over the projections.
function calibrateNFL(){
  const T=NFL.teams, N=250, f=(want,got)=>Math.pow(Math.max(want,0.05)/Math.max(got,0.05),0.7);
  T.forEach(t=>{t.cv=0.25;t.pace=1});
  for(let it=0;it<6;it++){
    const box=T.map(()=>({})), sc=[0,0];
    for(let s=0;s<N;s++){const g=simNFL(7000+s,true);sc[0]+=g.score[0];sc[1]+=g.score[1];
      for(const e of g.ev)for(const [ti,p,k,v] of e.bx){const b=box[ti][p]||(box[ti][p]={});b[k]=(b[k]||0)+v/N}}
    T.forEach((t,ti)=>{const b=id=>box[ti][id]||{}, q=b(t.qb.id);
      t.cv=clamp(t.cv+(t.target-sc[ti]/N)*0.05,0,0.95);
      // plays: the offense's pace, so its attempts plus carries come to the projected volume
      const want=t.qb.attempts+t.rush.reduce((a,p)=>a+p.carries,0), got=(q.att||0)+t.rush.reduce((a,p)=>a+(b(p.id).car||0),0);
      t.pace=clamp(t.pace*Math.pow(got/want,0.7),0.6,1.6);
      t.passRate=clamp(t.passRate*f(t.qb.attempts,q.att||0),0.25,0.9);
      t.cmp=clamp(t.cmp*f(t.qb.completions,q.cmp||0),0.35,0.85);
      t.rush.forEach(p=>{const x=b(p.id);p.wc*=f(p.carries,x.car||0);if(x.car>0.2&&p.rush_yards>0)p.rr*=f(p.rush_yards/p.carries,(x.ruyd||0)/x.car)});
      t.tgt.forEach(p=>{const x=b(p.id);p.wt*=f(p.receptions||0,x.rec||0);if(x.rec>0.2&&p.receptions>0.2)p.yc*=f(p.rec_yards/p.receptions,(x.ryd||0)/x.rec)});
    });
  }
}
function nflQ(c){return c>=3600?4:Math.min(3,Math.floor(c/900))}
function nflLeft(c){const q=nflQ(c);return q===4?4200-c:900*(q+1)-c}
function simNFL(seed,rec){
  const r=rng(seed), T=NFL.teams, score=[0,0], ev=[], line=[[],[],];
  let c=0, off=r()<0.5?0:1; const firstRecv=off;
  let yl=0, down=1, togo=10, half2=false, ot=false, otDrives=0, drive=0, dStart=0, dPlays=0;
  const add=e=>{if(rec){e.score=[...score];e.c=c;e.q=nflQ(c);e.drive=drive;e.dStart=dStart;e.dPlays=dPlays;e.firstRecv=firstRecv;ev.push(e)}};
  const bump=(ti,p)=>{const q=nflQ(Math.max(0,c-0.01));line[ti][q]=(line[ti][q]||0)+p};
  const newDrive=(team,start)=>{off=team;yl=start;down=1;togo=10;drive++;dStart=start;dPlays=0;if(ot)otDrives++};
  const kick=(recv)=>{const s=r()<0.62?35:20+Math.floor(r()*20);newDrive(recv,s);add({type:'kick',off:recv,y0:s,y1:s,bx:[]})};
  const tick=(sec)=>{const b=c<3600?900*(Math.floor(c/900)+1):4200;c=Math.min(c+sec*(T[off].pace||1),b)};
  const pickW=(arr,f)=>pick(r,arr,arr.map(f));
  kick(off);
  for(let guard=0;guard<400;guard++){
    if(!half2&&c>=1800){half2=true;kick(1-firstRecv)}
    if(!ot&&c>=3600){if(score[0]!==score[1])break;ot=true;kick(r()<0.5?0:1)}
    if(ot&&c>=4200)break;
    const o=T[off], q=nflQ(c), left=nflLeft(c), diff=score[off]-score[1-off];
    const hurry=(q===3&&left<300&&diff<0)||(q===1&&left<120);
    const y0=yl, d0=down, tg0=togo;
    const ctx={y0,down:d0,togo:tg0};
    if(down===4){
      const fgd=100-yl+17;
      const go=(togo<=1&&yl>=45&&r()<0.55)||(q===3&&left<240&&diff<0&&diff>=-8&&!(fgd<=56&&diff>=-3));
      if(!go){
        if(fgd<=56){
          const ok=r()<clamp(1.05-(fgd-25)*0.013,0.4,0.97); tick(5);
          if(ok){score[off]+=3;bump(off,3);add({...ctx,type:'fg',off,y1:100,dist:fgd,good:true,bx:[[off,'K','fga',1],[off,'K','fgm',1]]});
            if(ot&&otDrives>=2)break;
            kick(1-off)}
          else{add({...ctx,type:'fg',off,y1:y0,dist:fgd,good:false,bx:[[off,'K','fga',1]]});newDrive(1-off,clamp(100-(y0-7),20,99))}
          if(ot&&otDrives>2&&score[0]!==score[1])break;
          continue;
        }
        const net=36+Math.floor(r()*14), land=yl+net; tick(8);
        const ny=land>=100?20:Math.max(1,100-land);
        add({...ctx,type:'punt',off,y1:Math.min(land,100),net,bx:[]}); newDrive(1-off,ny);
        if(ot&&otDrives>2&&score[0]!==score[1])break;
        continue;
      }
    }
    let pr=o.passRate*0.9;
    if(down===3&&togo>=5)pr=0.75; else if(down>=3&&togo<=2)pr=0.35;
    if(hurry)pr=0.85; else if(q===3&&left<300&&diff>0)pr=0.3;
    let g=0, e;
    dPlays++;
    if(r()<pr){
      const qb=o.qb;
      if(r()<0.065){g=-(4+Math.floor(r()*6));tick(hurry?12:32);e={type:'sack',p:qb,bx:[]}}
      else if(r()<o.intr){const back=5+Math.floor(r()*20);tick(8);
        e={type:'int',p:qb,bx:[[off,qb.id,'att',1],[off,qb.id,'int',1]],ret:clamp(y0+back,1,99)}}
      else{const tg=pickW(o.tgt,p=>p.wt);
        if(r()<o.cmp){const m=o.legacy?tg.ypc*o.k:tg.yc;g=Math.max(0,Math.round(2+(-Math.log(1-r()))*Math.max(2,m-2)));
          const air=Math.min(g,Math.max(0,Math.round(g*(0.45+r()*0.4))));tick(hurry?14:34);
          e={type:'comp',p:qb,t:tg,air,bx:[[off,qb.id,'att',1],[off,qb.id,'cmp',1],[off,tg.id,'rec',1]]}}
        else{tick(6);const air=5+Math.floor(r()*18);e={type:'inc',p:qb,t:tg,air,bx:[[off,qb.id,'att',1]]}}
      }
    }else{
      const rb=pickW(o.rush,p=>p.wc);
      if(r()<0.09)g=-(1+Math.floor(r()*3)); else g=Math.round((-Math.log(1-r()))*((o.legacy?o.ypr*o.k:rb.rr)+0.18)/0.91);
      if(r()<0.007){tick(30);e={type:'fum',p:rb,bx:[[off,rb.id,'car',1]],ret:y0+Math.max(0,g)}}
      else{tick(hurry?14:36);e={type:'run',p:rb,bx:[[off,rb.id,'car',1]]}}
    }
    e.off=off; Object.assign(e,ctx);
    if(e.type==='int'||e.type==='fum'){e.y1=e.ret;add(e);newDrive(1-off,clamp(100-e.ret,1,99));if(ot&&otDrives>2&&score[0]!==score[1])break;continue}
    if(o.cv&&down>=3&&g<togo&&(e.type==='run'||e.type==='comp')&&r()<o.cv)g=togo;
    g=Math.min(g,100-yl); yl+=g; e.g=g; e.y1=yl;
    if(e.type==='comp'){e.bx.push([off,e.p.id,'pyd',g],[off,e.t.id,'ryd',g])}
    if(e.type==='run'){e.bx.push([off,e.p.id,'ruyd',g])}
    if(yl>=100){
      e.td=true; score[off]+=6; bump(off,6);
      if(e.type==='comp')e.bx.push([off,e.p.id,'ptd',1],[off,e.t.id,'rtd',1]); else e.bx.push([off,e.p.id,'rutd',1]);
      add(e);
      if(ot)break;
      const pat=r()<0.94; if(pat){score[off]+=1;bump(off,1)} add({type:'pat',off,good:pat,y0:98,y1:98,bx:pat?[[off,'K','xpa',1],[off,'K','xpm',1]]:[[off,'K','xpa',1]]});
      kick(1-off); continue;
    }
    if(yl<=0){score[1-off]+=2;bump(1-off,2);e.safety=true;add(e);kick(1-off);continue}
    if(g>=togo){down=1;togo=Math.min(10,100-yl);e.first=true}
    else{down++;togo-=g;if(down>4){add(e);newDrive(1-off,100-yl);e.downs=true;continue}}
    add(e);
  }
  return {score,ev,line,seed,periods:ot?5:4};
}
// Each team's box score of a recorded run: box[team][player][stat].
function boxOf(G,g){
  const box=G.teams.map(()=>({}));
  for(const e of g.ev)for(const [ti,p,k,v] of e.bx){const b=box[ti][p]||(box[ti][p]={});b[k]=(b[k]||0)+v}
  return box;
}
