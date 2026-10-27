const express=require('express'),http=require('http'),{Pool}=require('pg'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),{Server}=require('socket.io');
const SECRET=process.env.JWT_SECRET;
const ON_VERCEL=!!process.env.VERCEL;
if(!SECRET||SECRET.length<16){console.error('Set JWT_SECRET (16+ chars) in .env');if(!ON_VERCEL)process.exit(1)}
if(!process.env.DATABASE_URL){console.error('Set DATABASE_URL in .env');if(!ON_VERCEL)process.exit(1)}

let databaseUrl=process.env.DATABASE_URL;
if(databaseUrl){const url=new URL(databaseUrl);url.searchParams.delete('sslmode');databaseUrl=url.toString()}
const app=express(),srv=http.createServer(app),io=new Server(srv),db=new Pool({connectionString:databaseUrl,max:ON_VERCEL?3:10,ssl:databaseUrl&&!/localhost|127\.0\.0\.1/.test(databaseUrl)?{rejectUnauthorized:false}:undefined});
db.on('error',er=>console.error('Unexpected PostgreSQL pool error:',er));
const query=(text,values=[],client=db)=>client.query(text,values);
const one=async(text,values=[],client=db)=>(await query(text,values,client)).rows[0];
const all=async(text,values=[],client=db)=>(await query(text,values,client)).rows;
const run=async(text,values=[],client=db)=>(await query(text,values,client)).rowCount;
const transaction=async fn=>{const client=await db.connect();try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value}catch(er){try{await client.query('ROLLBACK')}catch(rollbackError){console.error('PostgreSQL rollback failed:',rollbackError)}throw er}finally{client.release()}};
const route=fn=>(q,s,n)=>Promise.resolve(fn(q,s,n)).catch(n);
const setS=(k,v,client=db)=>query('insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',[k,v],client);
const str=(v,n=80)=>String(v??'').trim().slice(0,n),bump=()=>io.emit('update');
const need=(condition,message)=>{if(!condition)throw Object.assign(new Error(message),{status:400})};
const teamFields=b=>{const raw=String(b.number??''),n=str(raw,10),m=str(b.name,60);need(raw.trim()&&m,'Team number and name are required');need(/^\d+$/.test(raw),'Team number must contain digits only');return[n,m]};

async function state(client=db){
  const [teams,rounds,scores,settings]=await Promise.all([
    all('select id,number,name,remarks from teams order by number::bigint,number',[],client),
    all('select * from rounds order by position,id',[],client),
    all('select team_id,round_id,marks from scores',[],client),
    all('select * from settings',[],client)
  ]);
  return{teams,rounds,scores,settings:Object.fromEntries(settings.map(r=>[r.key,r.value]))};
}
async function board(client=db){
  const s=await state(client),m={};
  s.scores.forEach(x=>m[x.team_id+'_'+x.round_id]=Number(x.marks));
  const mx=s.rounds.reduce((a,r)=>a+Number(r.max_marks),0);
  const a=s.teams.map(t=>({...t,tot:Math.round(s.rounds.reduce((x,r)=>x+(m[t.id+'_'+r.id]||0),0)*100)/100})).sort((x,y)=>y.tot-x.tot);
  a.forEach((t,i)=>t.rank=i&&a[i-1].tot===t.tot?a[i-1].rank:i+1);
  return{a,m,s,mx};
}
const ranks=async client=>Object.fromEntries((await board(client)).a.map(t=>[t.id,t.rank]));
const who=q=>{try{const c=(q.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tk='));return jwt.verify(c.slice(3),SECRET).u}catch{return null}};
const auth=(q,s,n)=>{q.user=who(q);q.user?n():s.status(401).json({error:'Login required'})};
const rd=b=>{const n=str(b.name,60),x=Number(b.max_marks),st=b.status==='completed'?'completed':'active';need(n&&Number.isFinite(x)&&x>0,'Round name and a maximum above 0 are required');return[n,x,st]};


app.use(express.json({limit:'5mb'}));app.use(express.static('public'));
const fails={};
let ready;
if(ON_VERCEL)app.use('/api',(q,s,n)=>{(ready||(ready=init().catch(e=>{ready=null;throw e}))).then(()=>n(),n)});
app.post('/api/login',route(async(q,s)=>{const k=q.ip,f=fails[k]||{n:0,t:Date.now()};if(Date.now()-f.t>9e5){f.n=0;f.t=Date.now()}
  if(f.n>=10)return s.status(429).json({error:'Too many attempts. Try again later.'});
  const u=await one('select * from admins where username=$1',[str(q.body.username)]);
  if(!u||!bcrypt.compareSync(String(q.body.password||''),u.pass_hash)){f.n++;fails[k]=f;return s.status(401).json({error:'Invalid username or password'})}
  delete fails[k];s.setHeader('Set-Cookie',`tk=${jwt.sign({u:u.username},SECRET,{expiresIn:'8h'})}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV==='production'?'; Secure':''}`);s.json({user:u.username})
}));
app.post('/api/logout',(q,s)=>{s.setHeader('Set-Cookie','tk=; HttpOnly; Path=/; Max-Age=0');s.json({ok:1})});
app.get('/api/me',(q,s)=>s.json({user:who(q)}));
app.get('/api/public',route(async(q,s)=>{const d=await state();if(!who(q))d.teams.forEach(t=>delete t.remarks);s.json(d)}));

app.post('/api/teams',auth,route(async(q,s)=>{const[n,m]=teamFields(q.body);need(!await one('select 1 from teams where number=$1',[n]),'Team number already exists');need(!await one('select 1 from teams where name=$1',[m]),'Team name already exists');await query('insert into teams(number,name) values($1,$2)',[n,m]);bump();s.json({ok:1})}));
app.put('/api/teams/:id',auth,route(async(q,s)=>{const[n,m]=teamFields(q.body);need(!await one('select 1 from teams where number=$1 and id<>$2',[n,q.params.id]),'Team number already exists');need(!await one('select 1 from teams where name=$1 and id<>$2',[m,q.params.id]),'Team name already exists');need(await run('update teams set number=$1,name=$2 where id=$3',[n,m,q.params.id]),'Team not found');bump();s.json({ok:1})}));
app.delete('/api/teams/:id',auth,route(async(q,s)=>{await query('delete from teams where id=$1',[q.params.id]);bump();s.json({ok:1})}));

app.post('/api/rounds',auth,route(async(q,s)=>{await query('insert into rounds(name,max_marks,status,position) values($1,$2,$3,(select coalesce(max(position),0)+1 from rounds))',rd(q.body));bump();s.json({ok:1})}));
app.put('/api/rounds/:id',auth,route(async(q,s)=>{const[n,x,st]=rd(q.body);need(!await one('select 1 from scores where round_id=$1 and marks>$2',[q.params.id,x]),'Existing marks exceed the new maximum');need(await run('update rounds set name=$1,max_marks=$2,status=$3 where id=$4',[n,x,st,q.params.id]),'Round not found');bump();s.json({ok:1})}));
app.delete('/api/rounds/:id',auth,route(async(q,s)=>{await query('delete from rounds where id=$1',[q.params.id]);bump();s.json({ok:1})}));

app.put('/api/scores',auth,route(async(q,s)=>{const{entries=[],remarks={}}=q.body;need(Array.isArray(entries),'Invalid data');
  await transaction(async client=>{let snap=false;
    for(const x of entries){
      const r=await one('select * from rounds where id=$1',[x.round_id],client),t=await one('select * from teams where id=$1',[x.team_id],client);need(r&&t,'Unknown team or round');
      const old=await one('select marks from scores where team_id=$1 and round_id=$2',[t.id,r.id],client),nv=x.marks===null||x.marks===''?null:Number(x.marks);
      need(nv===null||(Number.isFinite(nv)&&nv>=0&&nv<=Number(r.max_marks)),`Marks for ${t.name} in ${r.name} must be between 0 and ${r.max_marks}`);
      if((old?Number(old.marks):null)===nv)continue;
      if(!snap){await setS('prev_ranks',JSON.stringify(await ranks(client)),client);snap=true}
      if(nv===null)await query('delete from scores where team_id=$1 and round_id=$2',[t.id,r.id],client);
      else await query('insert into scores(team_id,round_id,marks) values($1,$2,$3) on conflict(team_id,round_id) do update set marks=excluded.marks',[t.id,r.id,nv],client);
      await query('insert into score_history(team_label,round_label,old_marks,new_marks,admin) values($1,$2,$3,$4,$5)',[`#${t.number} ${t.name}`,r.name,old?old.marks:null,nv,q.user],client);
    }
    for(const[id,v]of Object.entries(remarks))await query('update teams set remarks=$1 where id=$2',[str(v,300),id],client);
  });
  bump();s.json({ok:1})
}));
app.get('/api/history',auth,route(async(q,s)=>s.json(await all('select * from score_history order by id desc limit 200'))));
app.put('/api/settings',auth,route(async(q,s)=>{if(['Upcoming','Live','Completed'].includes(q.body.event_status))await setS('event_status',q.body.event_status);if(q.body.event_name)await setS('event_name',str(q.body.event_name,80));bump();s.json({ok:1})}));

app.get('/api/export.csv',auth,route(async(q,s)=>{const{a,m,s:st,mx}=await board(),c=v=>{v=String(v??'');if(/^[=+\-@\t\r]/.test(v))v="'"+v;return/[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
  const L=[['Rank','Team No','Team',...st.rounds.map(r=>`${r.name} (/${r.max_marks})`),'Total','Max','Percent'],...a.map(t=>[t.rank,t.number,t.name,...st.rounds.map(r=>m[t.id+'_'+r.id]??''),t.tot,mx,mx?(t.tot/mx*100).toFixed(2):'0'])];
  s.type('text/csv').attachment('syntrix-results.csv').send(L.map(r=>r.map(c).join(',')).join('\r\n'))
}));
app.get('/api/backup',auth,route(async(q,s)=>{const d={...await state(),history:await all('select * from score_history')};s.attachment('syntrix-backup.json').json(d)}));
app.post('/api/restore',auth,route(async(q,s)=>{const d=q.body.data;need(d&&Array.isArray(d.teams)&&Array.isArray(d.rounds)&&Array.isArray(d.scores),'Invalid backup file');
  const teamNos=new Set(),teamNames=new Set();
  for(const t of d.teams){const[n,m]=teamFields(t);need(!teamNos.has(n),'Team number already exists');need(!teamNames.has(m),'Team name already exists');teamNos.add(n);teamNames.add(m)}
  need(!d.settings||typeof d.settings==='object','Invalid backup settings');
  await transaction(async client=>{
    await query('delete from scores',[],client);await query('delete from score_history',[],client);await query('delete from teams',[],client);await query('delete from rounds',[],client);
    for(const t of d.teams)await query('insert into teams(id,number,name,remarks) values($1,$2,$3,$4)',[t.id,str(t.number,10),str(t.name,60),str(t.remarks,300)],client);
    for(const r of d.rounds)await query('insert into rounds(id,name,max_marks,status,position) values($1,$2,$3,$4,$5)',[r.id,str(r.name,60),r.max_marks,r.status==='completed'?'completed':'active',r.position|0],client);
    for(const x of d.scores)await query('insert into scores(team_id,round_id,marks) values($1,$2,$3)',[x.team_id,x.round_id,x.marks],client);
    for(const h of d.history||[])await query('insert into score_history(team_label,round_label,old_marks,new_marks,admin,at) values($1,$2,$3,$4,$5,$6)',[h.team_label,h.round_label,h.old_marks,h.new_marks,h.admin,h.at],client);
    await query('delete from settings',[],client);
    for(const[k,v]of Object.entries(d.settings||{}))if(k!=='prev_ranks')await setS(str(k,120),String(v),client);
    await setS('prev_ranks','',client);
    for(const table of ['teams','rounds','score_history'])await query(`select setval(pg_get_serial_sequence('${table}','id'),coalesce(max(id),1),count(*)>0) from ${table}`,[],client);
  });
  bump();s.json({ok:1})
}));
app.post('/api/reset',auth,route(async(q,s)=>{need(q.body.confirm==='RESET','Confirmation required');await transaction(async client=>{await query('delete from scores',[],client);await query('delete from score_history',[],client);await setS('prev_ranks','',client);if(q.body.mode==='all'){await query('delete from teams',[],client);await query('delete from rounds',[],client)}});bump();s.json({ok:1})}));

app.use('/api',(q,s)=>s.status(404).json({error:'Not found'}));
app.use((er,q,s,n)=>{const unique=er.code==='23505';if(!unique&&!er.status)console.error(er);s.status(unique?409:er.status||500).json({error:unique?'That value already exists':er.status?er.message:'Server error'})});

async function init(){
  await query('select 1');
  if(process.env.ADMIN_USER&&process.env.ADMIN_PASSWORD)await query('insert into admins(username,pass_hash) values($1,$2) on conflict(username) do update set pass_hash=excluded.pass_hash',[process.env.ADMIN_USER,bcrypt.hashSync(process.env.ADMIN_PASSWORD,ON_VERCEL?10:12)]);
  else if(!await one('select 1 from admins'))console.warn('No admin exists: set ADMIN_USER and ADMIN_PASSWORD in .env');
}
if(!ON_VERCEL){
  (async()=>{try{await init();const port=process.env.PORT||3000;srv.listen(port,()=>console.log('SYNTRIX running on port '+port))}catch(er){console.error('Could not connect to Supabase PostgreSQL or find its schema; check DATABASE_URL and run sql.md:',er);process.exit(1)}})();
}
module.exports=app;
