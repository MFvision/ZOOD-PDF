import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from texts import DOCS
F = os.path.normpath(os.path.join(HERE, '../../../fonts'))
SETS=[('letter','Amiri',F+'/Amiri-Regular.ttf',17),('contract','NotoNaskh',F+'/static/NotoNaskhArabic-Regular-static.ttf',15),('circular','NotoSans',F+'/static/NotoSansArabic-Regular-static.ttf',15),('report','Cairo',F+'/static/Cairo-Regular-static.ttf',15),
('letter','Plex',F+'/IBMPlexSansArabic-Regular.ttf',15),('contract','Scheherazade',F+'/ScheherazadeNew-Regular.ttf',19),('circular','Tajawal',F+'/Tajawal-Regular.ttf',16),('report','Naskh',F+'/static/NotoNaskhArabic-Regular-static.ttf',15)]
jobs=[]
for doc,name,path,size in SETS:
    body=''.join(f'<p>{l}</p>' for l in DOCS[doc].split('\n'))
    html=f'''<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><style>@font-face{{font-family:X;src:url(file://{path})}}
@page{{size:A4;margin:22mm 20mm}}body{{font-family:X;font-size:{size}px;line-height:1.7;text-align:justify}}p{{margin:0 0 7px}}</style><body>{body}</body></html>'''
    open(f'{doc}-{name}.html','w').write(html); open(f'{doc}-{name}.txt','w').write(DOCS[doc]+'\n'); jobs.append(f'{doc}-{name}')
json.dump(jobs,open('jobs.json','w'))
