
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{
  const el=document.getElementById(b.dataset.copy).cloneNode(true);el.querySelector('.copy')?.remove();
  try{await navigator.clipboard.writeText(el.textContent.trim());b.textContent='Copied'}catch(e){b.textContent='Select to copy'}
  setTimeout(()=>b.textContent='Copy',1600)}));
const demo=document.querySelector('.demo');
if(demo){
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const screen=demo.querySelector('.screen'),cur=demo.querySelector('.cursor'),line=demo.querySelector('.line'),who=demo.querySelector('.who'),st=demo.querySelector('.status span'),voice=demo.querySelector('.voice'),addr=demo.querySelector('.addr');
  const F=[
    {v:'a',who:'She says',say:'“Help me refill my prescription.”',st:'Listening',addr:'riverside-pharmacy.com',home:true},
    {v:'a',lit:'rxlink',who:'JustAsk',say:'“Click Prescriptions, at the top.”',st:'Step 1',addr:'riverside-pharmacy.com'},
    {v:'a',lit:'rxlink',who:'JustAsk',say:'“Click Prescriptions, at the top.”',st:'Step 1',addr:'riverside-pharmacy.com',to:'rxlink',quiet:true},
    {v:'b',lit:'refill',who:'JustAsk',say:'“Now click Refill, next to Lisinopril.”',st:'Step 2',addr:'riverside-pharmacy.com/prescriptions'},
    {v:'b',lit:'refill',who:'JustAsk',say:'“Now click Refill, next to Lisinopril.”',st:'Step 2',addr:'riverside-pharmacy.com/prescriptions',to:'refill',quiet:true},
    {v:'c',who:'JustAsk',say:'“Done. You did it.”',st:'Done',addr:'riverside-pharmacy.com/prescriptions'}
  ];
  const place=(x,y)=>cur.style.transform=`translate(${x}px,${y}px)`;
  function target(id){const el=demo.querySelector('#'+id),r=el.getBoundingClientRect(),s=screen.getBoundingClientRect();return [r.left-s.left+r.width*.55,r.top-s.top+r.height*.55]}
  function show(n){
    const f=F[n];
    demo.querySelectorAll('.view').forEach(v=>v.classList.toggle('on',v.dataset.v===f.v));
    demo.querySelectorAll('.t').forEach(t=>t.classList.toggle('lit',t.id===f.lit));
    line.textContent=f.say;who.textContent=f.who;st.textContent=f.st;addr.textContent=f.addr;
    voice.classList.toggle('quiet',!!f.quiet);
    if(f.home){const s=screen.getBoundingClientRect();place(s.width*.62,s.height*.78)}
    if(f.to){const p=target(f.to);place(p[0],p[1]);setTimeout(()=>{cur.classList.add('press');setTimeout(()=>cur.classList.remove('press'),180)},950)}
  }
  if(reduce){show(1)}else{show(0);let i=0;setInterval(()=>{i=(i+1)%F.length;show(i)},2300)}
}
