import os,sys,subprocess,textwrap,json
from PIL import Image,ImageDraw,ImageFont
SP='/tmp/claude-0/-home-claude/c876c197-6190-5bb9-bf26-00f37d5ecb49/scratchpad/'
V=SP+'vid/';O=SP+'vidout/';os.makedirs(O,exist_ok=True)
F='/usr/share/fonts/opentype/inter/Inter-'
fR=ImageFont.truetype(F+'Medium.otf',27);fB=ImageFont.truetype(F+'Bold.otf',20);fT=ImageFont.truetype(F+'Bold.otf',54);fS=ImageFont.truetype(F+'Medium.otf',28);fX=ImageFont.truetype(F+'Medium.otf',16)
NAVY=(0,74,130);OR=(232,101,15)
S=[
('T','Plataforma de Comissionamento dos Trackers HD','UFV Lagoinha · Visão executiva e passo a passo de uso',None),
('01_mapa','Mapa do parque','Cada fileira aparece com a cor da etapa em que está. A legenda, à esquerda, explica todas as cores; no celular, toque em “Legenda”.',None),
('02_exec','Visão executiva','A primeira aba reúne o essencial para a tomada de decisão. O “Resumo do dia” traduz os números em uma frase: avanço, ritmo e término previsto.',None),
('03_kpi','Indicadores principais','Seis números respondem “onde estamos”: inspeção concluída, comissionadas, NC em aberto, desvio do plano HD, observação de 15 dias e materiais em falta.',None),
('04_kpi_info','Botão “i”','Toque no “i” ao lado de cada título para ler o que o indicador mostra e como é calculado. Os cartões levam à aba de detalhe.',None),
('05_funil','Em que etapa estão as fileiras','Mostra onde o fluxo trava: muitas fileiras aguardando assinaturas indicam gargalo de assinatura; muitas em “NC em correção”, gargalo de execução da HD.',None),
('06_lag','Avanço por parque e ritmo semanal','Compare LAG01 a LAG04 e acompanhe a produção semanal. Queda no ritmo antecipa atraso no término.',None),
('07_atencao','Pontos de atenção','Lista automática do que precisa de decisão ou cobrança, já com o responsável pela próxima ação. Clique para abrir a aba correspondente.',None),
('08_ajuda','Aba Ajuda','Tour guiado, vídeo, passo a passo por perfil, significado das cores e perguntas frequentes, sempre disponíveis no menu.',None),
('09_fluxo','O fluxo de uma fileira','Inspeção → assinatura HD → validação CGN → correção → observação de 15 dias úteis → comissionamento com quatro assinaturas.',None),
('10_insp','Inspetor HD / Quality','Abra a inspeção, marque OK, NOK ou N/A, registre medições e fotos. Em cada NOK, descreva o estado encontrado antes de qualquer ajuste.',None),
('11_tec','Técnico HD','Corrija apenas o que estiver liberado (mecânica, elétrica ou ambas), registre descrição e foto e toque em “Atestar: resolvido e OK”.',None),
('12_cgn','Fiscal CGN','Valide relatórios, aceite ou devolva correções, registre a checagem diária da observação e assine o relatório final.',None),
('13_cores','O que significa cada cor','O glossário traz todas as cores do mapa, da fileira não iniciada até a comissionada.',None),
('E','Dúvidas e permissões','Leonardo Dantas (CGN) · leonardo.dantas@cgnbe.com.br',None)]
def wrap(d,t,f,w):
  out=[];cur=''
  for wd in t.split():
    x=(cur+' '+wd).strip()
    if d.textlength(x,font=f)<=w:cur=x
    else: out.append(cur);cur=wd
  out.append(cur);return out
def frame(k,ttl,cap):
  if k in('T','E'):
    im=Image.new('RGB',(1280,720),NAVY);d=ImageDraw.Draw(im)
    d.rectangle((0,700,1280,720),fill=OR)
    ls=wrap(d,ttl,fT,1080);y=360-len(ls)*34-30
    for l in ls:d.text((100,y),l,font=fT,fill='white');y+=68
    d.text((100,y+18),cap,font=fS,fill=(200,220,240));return im
  im=Image.open(V+k+'.jpg').convert('RGB').resize((1280,720));d=ImageDraw.Draw(im,'RGBA')
  ls=wrap(d,cap,fR,1160);h=34+len(ls)*38+22
  d.rectangle((0,720-h,1280,720),fill=(10,22,40,228));d.rectangle((0,720-h,8,720),fill=OR)
  d.text((40,720-h+14),ttl.upper(),font=fB,fill=(255,170,110))
  y=720-h+44
  for l in ls:d.text((40,y),l,font=fR,fill='white');y+=38
  d.rounded_rectangle((1110,96,1268,124),6,fill=(10,22,40,200));d.text((1122,100),'Dados ilustrativos',font=fX,fill='white')
  return im
srt=[];t=0.0
def ts(x):h=int(x//3600);m=int(x%3600//60);s=x%60;return f'{h:02}:{m:02}:{int(s):02},{int(round((s-int(s))*1000)):03}'
mode=sys.argv[1] if len(sys.argv)>1 else 'frames'
files=[]
for i,(k,ttl,cap,_) in enumerate(S):
  im=frame(k,ttl,cap);png=O+f's{i:02}.png';im.save(png)
  dur=4.5 if k in('T','E') else max(6.0,round(len(cap)/15+1.5,1))
  srt.append((t,t+dur,ttl+' — '+cap if k not in('T','E') else ttl+'. '+cap));t+=dur
  if mode=='render':
    out=O+f's{i:02}.mp4';tmp=O+f's{i:02}.tmp.mp4'
    vf=f'format=yuv420p,loop=-1:1,trim=duration={dur},fade=t=in:st=0:d=0.4,fade=t=out:st={dur-0.4}:d=0.4'
    r=subprocess.run(['ffmpeg','-y','-loglevel','error','-framerate','30','-i',png,'-vf',vf,'-c:v','libx264','-crf','18','-preset','veryfast','-pix_fmt','yuv420p','-r','30',tmp])
    if r.returncode==0:os.replace(tmp,out);files.append(out)
    else: sys.exit('fail '+k)
if mode=='render':
  open(O+'list.txt','w').write(''.join(f"file '{f}'\n" for f in files))
  subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',O+'list.txt','-c','copy',O+'tutorial_lagoinha.mp4'],check=True)
  with open(O+'tutorial_lagoinha.srt','w',encoding='utf-8') as f:
    for j,(a,b,c) in enumerate(srt,1):f.write(f'{j}\n{ts(a)} --> {ts(b)}\n{c}\n\n')
print('total',round(t,1))
