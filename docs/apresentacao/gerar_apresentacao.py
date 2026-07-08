# -*- coding: utf-8 -*-
"""
Gerador da apresentacao TED-talk do Web3Community.

Numeros validados contra os contratos / ignition/parameters/production.json:
  split default 70/20/10 (Fase 0), alpha 0.95, buckets 55/25/15/5,
  genesis 10M CREDIT -> Treasury, quorum 4%, supermaioria 75% p/ removePOL.

Requer python-pptx. Gera: web3community-modelo-de-negocio.pptx
Regeneravel: basta reexecutar.
"""
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
import os

# ---------- paleta ----------
BG      = RGBColor(0x0E, 0x11, 0x16)   # fundo escuro
FG      = RGBColor(0xED, 0xEF, 0xF2)   # texto claro
MUTED   = RGBColor(0x8A, 0x93, 0xA0)   # texto secundario
ACCENT  = RGBColor(0x38, 0xD9, 0xB0)   # verde-agua (destaque unico)
ACCENT2 = RGBColor(0xF2, 0xB0, 0x4A)   # ambar (usado com parcimonia p/ alerta)
CARD    = RGBColor(0x1A, 0x1F, 0x27)   # cartao
RED     = RGBColor(0xE8, 0x6A, 0x6A)   # negativo / comparativo

FONT = "Arial"

# 16:9
prs = Presentation()
prs.slide_width  = Inches(13.333)
prs.slide_height = Inches(7.5)
SW, SH = prs.slide_width, prs.slide_height
BLANK = prs.slide_layouts[6]


def slide():
    s = prs.slides.add_slide(BLANK)
    r = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SW, SH)
    r.fill.solid(); r.fill.fore_color.rgb = BG
    r.line.fill.background()
    r.shadow.inherit = False
    s.shapes._spTree.remove(r._element)
    s.shapes._spTree.insert(2, r._element)
    return s


def txt(s, x, y, w, h, text, size, color=FG, bold=False, align=PP_ALIGN.LEFT,
        anchor=MSO_ANCHOR.TOP, italic=False, spacing=1.0, font=FONT):
    tb = s.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    lines = text.split("\n")
    for i, ln in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        r = p.add_run(); r.text = ln
        f = r.font
        f.size = Pt(size); f.name = font
        f.bold = bold; f.italic = italic
        f.color.rgb = color
    return tb


def accent_bar(s, x, y, w=Inches(0.9), h=Inches(0.09), color=ACCENT):
    b = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    b.fill.solid(); b.fill.fore_color.rgb = color
    b.line.fill.background(); b.shadow.inherit = False
    return b


def card(s, x, y, w, h, color=CARD):
    c = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h)
    c.fill.solid(); c.fill.fore_color.rgb = color
    c.line.fill.background(); c.shadow.inherit = False
    try:
        c.adjustments[0] = 0.06
    except Exception:
        pass
    return c


def kicker(s, text, color=ACCENT):
    accent_bar(s, Inches(0.9), Inches(0.7))
    txt(s, Inches(0.9), Inches(0.92), Inches(11), Inches(0.5),
        text.upper(), 15, color=color, bold=True, spacing=1.0)


NOTES = []


def note(s, text):
    s.notes_slide.notes_text_frame.text = text


# =====================================================================
# SLIDE 1 — TITULO
# =====================================================================
s = slide()
accent_bar(s, Inches(0.9), Inches(2.55), w=Inches(1.4), h=Inches(0.12))
txt(s, Inches(0.9), Inches(2.75), Inches(11.5), Inches(1.6),
    "Web3Community", 60, color=FG, bold=True)
txt(s, Inches(0.92), Inches(3.9), Inches(11.2), Inches(1.6),
    "E se USAR um aplicativo tornasse a moeda\nmais valiosa?",
    32, color=ACCENT, bold=False, spacing=1.05)
txt(s, Inches(0.95), Inches(6.6), Inches(11), Inches(0.5),
    "Uma economia onde o cliente é sócio.", 16, color=MUTED, italic=True)
note(s, "Boa noite. Quero começar com uma pergunta que parece absurda: e se toda vez "
        "que você usasse um app, a moeda daquele ecossistema ficasse mais valiosa? "
        "Não porque alguém especulou. Porque VOCÊ usou. Nos próximos minutos vou mostrar "
        "um sistema onde usar é o que cria valor — e vou provar com números, e vou ser "
        "honesto sobre onde ele pode falhar.")

# =====================================================================
# SLIDE 2 — O PROBLEMA
# =====================================================================
s = slide()
kicker(s, "O problema")
txt(s, Inches(0.9), Inches(1.7), Inches(11.5), Inches(1.8),
    "Cada aplicativo é uma ilha.", 44, color=FG, bold=True)
items = [
    ("Pagamento", "cada app com seu gateway, sua taxa, seu cadastro."),
    ("Fidelidade", "seus pontos morrem quando você troca de app."),
    ("Comunidade", "você nunca é dono de nada — só cliente."),
]
x = Inches(0.9)
cw = Inches(3.72); gap = Inches(0.18)
for i, (h, d) in enumerate(items):
    cx = x + (cw + gap) * i
    card(s, cx, Inches(3.7), cw, Inches(2.5))
    txt(s, cx + Inches(0.3), Inches(3.95), cw - Inches(0.6), Inches(0.6),
        h, 22, color=ACCENT, bold=True)
    txt(s, cx + Inches(0.3), Inches(4.7), cw - Inches(0.6), Inches(1.4),
        d, 18, color=FG, spacing=1.1)
note(s, "Hoje o mundo digital é feito de ilhas. Cada aplicativo tem seu próprio "
        "pagamento, sua própria taxa. Seus pontos de fidelidade de um app não valem "
        "nada no outro. E no fim, você é sempre só cliente — nunca dono. Cada vez que "
        "você troca de app, recomeça do zero. Esse é o desperdício que a gente aceitou "
        "como normal.")

# =====================================================================
# SLIDE 3 — A IDEIA
# =====================================================================
s = slide()
kicker(s, "A ideia")
txt(s, Inches(0.9), Inches(1.7), Inches(11.5), Inches(2.4),
    "Uma moeda para muitos apps.\nUma comunidade dona de tudo.",
    40, color=FG, bold=True, spacing=1.05)
txt(s, Inches(0.9), Inches(4.4), Inches(11.3), Inches(1.4),
    "Um saldo que funciona em todos os apps. Um sistema governado por quem participa.",
    22, color=FG, spacing=1.15)
txt(s, Inches(0.9), Inches(5.9), Inches(11.3), Inches(0.9),
    "Um shopping onde os clientes são os sócios.",
    24, color=ACCENT, bold=True, italic=True)
note(s, "A ideia é simples de dizer e difícil de fazer: e se em vez de mil ilhas, "
        "houvesse UMA moeda que funciona em muitos apps? E se o dono desse sistema não "
        "fosse uma empresa, mas a própria comunidade que usa? Pensa num shopping — só "
        "que os clientes são os sócios. Quem frequenta, decide, e lucra.")

# =====================================================================
# SLIDE 4 — O INSIGHT (BURN)
# =====================================================================
s = slide()
kicker(s, "O insight central")
txt(s, Inches(0.9), Inches(1.55), Inches(11.5), Inches(1.6),
    "Quando você gasta,\nparte da moeda é destruída.", 40, color=FG, bold=True, spacing=1.05)
card(s, Inches(0.9), Inches(4.15), Inches(11.5), Inches(2.4))
txt(s, Inches(1.3), Inches(4.5), Inches(10.7), Inches(0.8),
    "Como um banco central que recolhe a cédula gasta — e tritura.",
    24, color=ACCENT, bold=True)
txt(s, Inches(1.3), Inches(5.5), Inches(10.7), Inches(0.9),
    "Menos moeda em circulação = cada moeda que sobra vale um pouco mais.",
    22, color=FG, spacing=1.1)
note(s, "Aqui está o pulo do gato. No jargão chamamos de 'burn'. Quando você gasta a "
        "moeda — o CREDIT — parte dela não é transferida pra ninguém. Ela é destruída. "
        "Apagada da existência. Pensa num banco central que recolhe a cédula velha e "
        "tritura. Por que fazer isso? Porque menos moeda circulando significa que cada "
        "moeda restante fica mais escassa. Usar o sistema encolhe o dinheiro.")

# =====================================================================
# SLIDE 5 — O MOTOR
# =====================================================================
s = slide()
kicker(s, "O motor")
txt(s, Inches(0.9), Inches(1.5), Inches(11.5), Inches(1.0),
    "A cada rodada de 7 dias:", 34, color=FG, bold=True)
# duas caixas: queima vs nasce
bw = Inches(5.1); by = Inches(2.9); bh = Inches(2.2)
card(s, Inches(0.9), by, bw, bh)
txt(s, Inches(0.9), by + Inches(0.35), bw, Inches(0.6), "QUEIMOU", 20, color=MUTED, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(0.9), by + Inches(0.95), bw, Inches(1.0), "100.000", 48, color=FG, bold=True, align=PP_ALIGN.CENTER)
# seta
txt(s, Inches(6.0), by + Inches(0.75), Inches(1.3), Inches(0.8), "→", 44, color=ACCENT, bold=True, align=PP_ALIGN.CENTER)
card(s, Inches(7.35), by, bw, bh)
txt(s, Inches(7.35), by + Inches(0.35), bw, Inches(0.6), "NASCEM SÓ", 20, color=MUTED, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(7.35), by + Inches(0.95), bw, Inches(1.0), "95.000", 48, color=ACCENT, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(0.9), Inches(5.55), Inches(11.5), Inches(1.3),
    "O sistema devolve sempre MENOS do que destrói.  (fator α = 0,95)\nDeflação por design — gravada no código, a governança não pode reverter.",
    22, color=FG, bold=False, spacing=1.2)
note(s, "E aqui o motor fecha. A cada rodada — sete dias — o protocolo olha quanto foi "
        "queimado e emite moeda nova. Mas com uma regra de ferro: emite só 95% do que "
        "foi destruído. Queimou cem mil, nascem noventa e cinco mil. Esse fator, o alfa, "
        "é 0,95 e está travado no código — nem a comunidade consegue votar pra deixá-lo "
        "acima de 1. Ou seja: o sistema SEMPRE devolve menos do que consome. Deflação não "
        "é promessa de marketing. É matemática obrigatória.")

# =====================================================================
# SLIDE 6 — 4 BUCKETS
# =====================================================================
s = slide()
kicker(s, "Para onde vai a moeda nova")
txt(s, Inches(0.9), Inches(1.55), Inches(11.5), Inches(1.0),
    "Quatro grupos que sustentam o sistema.", 34, color=FG, bold=True)
buckets = [
    ("55%", "Apoiadores", "quem trava GOV apostando nos apps bons", ACCENT),
    ("25%", "Liquidez", "quem garante que dá pra comprar e vender", ACCENT),
    ("15%", "Apps", "os aplicativos, por gerarem uso real", ACCENT),
    ("5%",  "Tesouro", "reforça a liquidez do próprio protocolo", ACCENT),
]
# barra horizontal proporcional
bx = Inches(0.9); bw_total = Inches(11.5); by = Inches(3.0); bh = Inches(0.9)
props = [0.55, 0.25, 0.15, 0.05]
colors_bar = [ACCENT, RGBColor(0x2E,0xA6,0x8A), RGBColor(0x24,0x7A,0x66), RGBColor(0x1B,0x53,0x46)]
cx = bx
for p, col in zip(props, colors_bar):
    seg = Emu(int(bw_total * p))
    r = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, cx, by, seg, bh)
    r.fill.solid(); r.fill.fore_color.rgb = col
    r.line.color.rgb = BG; r.line.width = Pt(2); r.shadow.inherit = False
    cx = Emu(cx + seg)
# cards abaixo
cw = Inches(2.74); gap = Inches(0.18); x = Inches(0.9)
for i, (pct, h, d, col) in enumerate(buckets):
    cxx = x + (cw + gap) * i
    card(s, cxx, Inches(4.3), cw, Inches(2.2))
    txt(s, cxx, Inches(4.5), cw, Inches(0.8), pct, 36, color=col, bold=True, align=PP_ALIGN.CENTER)
    txt(s, cxx, Inches(5.35), cw, Inches(0.5), h, 19, color=FG, bold=True, align=PP_ALIGN.CENTER)
    txt(s, cxx + Inches(0.2), Inches(5.85), cw - Inches(0.4), Inches(0.9), d, 14, color=MUTED, align=PP_ALIGN.CENTER, spacing=1.05)
note(s, "A moeda nova não vai pro bolso de um fundador. Ela é dividida em quatro. "
        "55% vai pros apoiadores — quem trava seu token de governança apostando nos apps "
        "que geram uso real. 25% pra quem fornece liquidez, pra você conseguir comprar e "
        "vender. 15% pros próprios apps. E 5% pro tesouro da comunidade. Repare: cada "
        "fatia tem uma função no sistema. Ninguém ganha de graça.")

# =====================================================================
# SLIDE 7 — POR QUE UM APP ENTRARIA
# =====================================================================
s = slide()
kicker(s, "Por que um app entraria")
txt(s, Inches(0.9), Inches(1.5), Inches(11.5), Inches(1.5),
    "O app não paga taxa.\nO app RECEBE.", 42, color=FG, bold=True, spacing=1.05)
three = [
    ("10%", "Cashback", "em cada pagamento processado"),
    ("15%", "Fatia da emissão", "proporcional ao uso que gera"),
    ("+", "Rendimento", "se apostar no próprio sucesso"),
]
cw = Inches(3.72); gap = Inches(0.18); x = Inches(0.9)
for i, (pct, h, d) in enumerate(three):
    cxx = x + (cw + gap) * i
    card(s, cxx, Inches(4.15), cw, Inches(2.4))
    txt(s, cxx, Inches(4.4), cw, Inches(0.9), pct, 40, color=ACCENT, bold=True, align=PP_ALIGN.CENTER)
    txt(s, cxx, Inches(5.35), cw, Inches(0.5), h, 20, color=FG, bold=True, align=PP_ALIGN.CENTER)
    txt(s, cxx + Inches(0.2), Inches(5.85), cw - Inches(0.4), Inches(0.7), d, 15, color=MUTED, align=PP_ALIGN.CENTER, spacing=1.05)
note(s, "Agora, por que um aplicativo entraria nisso? Aqui está a inversão que muda o "
        "jogo. Num gateway comum, o app PAGA de 3 a 5% pra processar pagamento. Aqui é o "
        "contrário: o app tem TRÊS receitas. Recebe 10% de cashback em cada pagamento. "
        "Recebe uma fatia dos 15% da emissão, proporcional ao uso que gera. E, se quiser, "
        "ganha rendimento apostando no próprio sucesso. O app não é taxado. O app é pago "
        "pra participar.")

# =====================================================================
# SLIDE 8 — FOTOAI
# =====================================================================
s = slide()
kicker(s, "Um exemplo real")
txt(s, Inches(0.9), Inches(1.7), Inches(11.5), Inches(1.4),
    "FotoAI: um app de imagens por IA.", 40, color=FG, bold=True)
card(s, Inches(0.9), Inches(3.6), Inches(11.5), Inches(2.9))
txt(s, Inches(1.3), Inches(3.95), Inches(10.7), Inches(0.9),
    "A Bia quer 10 imagens. Paga R$ 9 no PIX.", 26, color=FG, bold=True)
txt(s, Inches(1.3), Inches(4.85), Inches(10.7), Inches(0.8),
    "Ela nunca vê a palavra “cripto”. Nunca cria uma carteira.", 20, color=MUTED)
txt(s, Inches(1.3), Inches(5.55), Inches(10.7), Inches(0.8),
    "Só percebe que ficou 10% mais barato que o concorrente.", 22, color=ACCENT, bold=True)
note(s, "Vamos deixar concreto. FotoAI: um app que gera imagens por inteligência "
        "artificial. A Bia quer dez imagens. Ela paga nove reais no Pix. Ponto. Ela não "
        "sabe o que é blockchain, não cria carteira, não vê a palavra cripto em lugar "
        "nenhum. Nos bastidores o real virou CREDIT, mas pra ela foi só um pagamento — "
        "e 10% mais barato que o concorrente. A tecnologia sumiu. Sobrou o benefício.")

# =====================================================================
# SLIDE 9 — RODADA EM NUMEROS
# =====================================================================
s = slide()
kicker(s, "Uma rodada da FotoAI")
txt(s, Inches(0.9), Inches(1.35), Inches(11.5), Inches(0.9),
    "600.000 CREDIT de volume → três receitas", 30, color=FG, bold=True)
rows = [
    ("Cashback (rebate 10%)", "$ 6.000"),
    ("Fatia dos apps (bucket 15%)", "$ 8.550"),
    ("Rendimento do stake próprio", "$ 15.675"),
]
y = Inches(2.6); rh = Inches(0.95); rw = Inches(11.5)
for i, (lab, val) in enumerate(rows):
    ry = y + rh * i
    card(s, Inches(0.9), ry, rw, Inches(0.8))
    txt(s, Inches(1.3), ry, Inches(8), Inches(0.8), lab, 22, color=FG, anchor=MSO_ANCHOR.MIDDLE)
    txt(s, Inches(9.0), ry, Inches(3.0), Inches(0.8), val, 26, color=ACCENT, bold=True,
        align=PP_ALIGN.RIGHT, anchor=MSO_ANCHOR.MIDDLE)
# total
ty = y + rh * 3 + Inches(0.15)
card(s, Inches(0.9), ty, rw, Inches(0.95), color=RGBColor(0x14,0x2A,0x24))
txt(s, Inches(1.3), ty, Inches(8), Inches(0.95), "TOTAL POR RODADA (7 dias)", 22, color=FG, bold=True, anchor=MSO_ANCHOR.MIDDLE)
txt(s, Inches(8.5), ty, Inches(3.5), Inches(0.95), "$ 30.225", 32, color=ACCENT, bold=True,
    align=PP_ALIGN.RIGHT, anchor=MSO_ANCHOR.MIDDLE)
note(s, "Agora os números — e todos vêm dos contratos reais, não de um chute de slide. "
        "Digamos que numa rodada a FotoAI gere 600 mil CREDIT de volume. Ela ganha em "
        "três lugares: seis mil dólares de cashback, oito mil e quinhentos da fatia dos "
        "apps, e quinze mil e seiscentos de rendimento por ter apostado em si mesma. "
        "Total: trinta mil dólares por semana só em receita de token — em cima do que ela "
        "já ganha vendendo o serviço.")

# =====================================================================
# SLIDE 10 — COMPARACAO MATADORA
# =====================================================================
s = slide()
kicker(s, "A comparação que decide")
txt(s, Inches(0.9), Inches(1.4), Inches(11.5), Inches(0.9),
    "Lucro por rodada — mesmo dando 10% de desconto", 28, color=FG, bold=True)
# duas colunas comparativas
bw = Inches(5.5); by = Inches(2.7); bh = Inches(2.9)
card(s, Inches(0.9), by, bw, bh)
txt(s, Inches(0.9), by + Inches(0.35), bw, Inches(0.6), "GATEWAY TRADICIONAL", 18, color=MUTED, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(0.9), by + Inches(1.15), bw, Inches(1.1), "$ 37.900", 46, color=RED, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(0.9), by + Inches(2.25), bw, Inches(0.5), "paga taxa, sem loyalty", 16, color=MUTED, align=PP_ALIGN.CENTER)
card(s, Inches(6.93), by, bw, bh, color=RGBColor(0x14,0x2A,0x24))
txt(s, Inches(6.93), by + Inches(0.35), bw, Inches(0.6), "COM WEB3COMMUNITY", 18, color=ACCENT, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(6.93), by + Inches(1.15), bw, Inches(1.1), "$ 44.225", 46, color=ACCENT, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(6.93), by + Inches(2.25), bw, Inches(0.5), "+17% de lucro", 18, color=ACCENT, align=PP_ALIGN.CENTER, bold=True)
txt(s, Inches(0.9), Inches(6.0), Inches(11.5), Inches(1.0),
    "O desconto ao cliente é pago pelo protocolo — não pela empresa.",
    24, color=FG, bold=True, align=PP_ALIGN.CENTER, italic=True)
note(s, "E aqui está a comparação que decide tudo. A MESMA empresa, no gateway "
        "tradicional, lucra 37.900. Dentro do Web3Community, lucra 44.225 — 17% a mais. "
        "E olha o detalhe: isso já contando o desconto de 10% que ela deu pra Bia. Como "
        "isso é possível? Porque o desconto não sai do bolso da empresa. Sai da emissão "
        "do protocolo. A comunidade subsidia a atração de clientes. Todo mundo ganha.")

# =====================================================================
# SLIDE 11 — ISSO SE SUSTENTA?
# =====================================================================
s = slide()
kicker(s, "Isso se sustenta?")
txt(s, Inches(0.9), Inches(1.4), Inches(11.5), Inches(0.9),
    "O teste: entra mais do que sai.", 34, color=FG, bold=True)
bw = Inches(5.5); by = Inches(2.7); bh = Inches(2.2)
card(s, Inches(0.9), by, bw, bh, color=RGBColor(0x14,0x2A,0x24))
txt(s, Inches(0.9), by + Inches(0.3), bw, Inches(0.6), "ENTRA (uso real)", 18, color=ACCENT, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(0.9), by + Inches(0.95), bw, Inches(1.0), "$ 150.000", 44, color=ACCENT, bold=True, align=PP_ALIGN.CENTER)
card(s, Inches(6.93), by, bw, bh)
txt(s, Inches(6.93), by + Inches(0.3), bw, Inches(0.6), "SAI (emissão máx.)", 18, color=MUTED, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(6.93), by + Inches(0.95), bw, Inches(1.0), "$ 142.500", 44, color=FG, bold=True, align=PP_ALIGN.CENTER)
txt(s, Inches(0.9), Inches(5.35), Inches(11.5), Inches(1.6),
    "Cada $1 gasto gera no máximo $0,665 de emissão.\nFolga estrutural de 33,5% — a matemática empurra a favor.",
    24, color=FG, bold=False, spacing=1.25)
note(s, "Mas será que se sustenta? A pergunta certa é: entra mais do que sai? Numa rodada "
        "de uso real, entram 150 mil dólares de gente comprando CREDIT pra usar os apps. "
        "E sai, no MÁXIMO, 142.500 de emissão. Por quê? Porque cada dólar gasto vira só "
        "66 centavos e meio de moeda nova — o resto foi queimado. Existe uma folga "
        "estrutural de 33,5% embutida na matemática. O sistema é desenhado pra que a "
        "entrada supere a saída, desde que o uso seja real.")

# =====================================================================
# SLIDE 12 — AS DEFESAS
# =====================================================================
s = slide()
kicker(s, "As defesas")
txt(s, Inches(0.9), Inches(1.5), Inches(11.5), Inches(1.0),
    "Quatro travas contra o colapso.", 34, color=FG, bold=True)
defs = [
    ("Piso de preço", "o tesouro compra e QUEIMA quando o preço cai — floor defendido"),
    ("Liquidez própria", "o protocolo é dono da própria liquidez (POL) — não depende de mercenário"),
    ("Teto de emissão", "α nunca ≥ 1, gravado no código — inflação líquida é impossível"),
    ("Supermaioria 75%", "mexer na liquidez exige 75% dos votos — não uma minoria"),
]
cw = Inches(5.66); gap = Inches(0.18); ch = Inches(1.75)
for i, (h, d) in enumerate(defs):
    col = i % 2; row = i // 2
    cxx = Inches(0.9) + (cw + gap) * col
    cyy = Inches(3.0) + (ch + Inches(0.2)) * row
    card(s, cxx, cyy, cw, ch)
    txt(s, cxx + Inches(0.35), cyy + Inches(0.25), cw - Inches(0.7), Inches(0.5), h, 22, color=ACCENT, bold=True)
    txt(s, cxx + Inches(0.35), cyy + Inches(0.85), cw - Inches(0.7), Inches(0.8), d, 15, color=FG, spacing=1.05)
note(s, "E se der errado? O sistema tem quatro travas. Um: um piso de preço — quando o "
        "CREDIT cai demais, o tesouro compra e queima automaticamente. Dois: o protocolo "
        "é dono da própria liquidez, não depende de investidor mercenário que foge na "
        "crise. Três: o teto de emissão, o alfa, nunca pode chegar a 1 — está no código, "
        "é impossível criar inflação líquida. Quatro: mexer na liquidez do protocolo exige "
        "75% dos votos, não uma minoria oportunista. Essas quatro não são promessas. São código.")

# =====================================================================
# SLIDE 13 — A HONESTIDADE (virada)
# =====================================================================
s = slide()
# fundo levemente diferente pra marcar a virada
txt(s, Inches(0.9), Inches(1.9), Inches(11.5), Inches(1.6),
    "Tokenomics não salva\nproduto ruim.", 48, color=ACCENT2, bold=True, spacing=1.05)
txt(s, Inches(0.9), Inches(4.3), Inches(11.3), Inches(1.6),
    "Se os apps não geram uso real, o sistema desacelera até parar.",
    26, color=FG, spacing=1.15)
txt(s, Inches(0.9), Inches(5.7), Inches(11.3), Inches(1.2),
    "Mas ele NÃO implode: sem alavancagem, sem promessa de rendimento fixo.\nNo pior caso, vira zumbi — não vira Ponzi.",
    20, color=MUTED, spacing=1.2)
note(s, "Agora preciso ser honesto com vocês — porque todo pitch esconde isso, e eu não vou. "
        "Nada disso salva um produto ruim. Se os apps não geram uso de verdade, não há "
        "queima; sem queima, não há recompensa; o sistema desacelera até parar. A "
        "diferença é: ele não EXPLODE. Não tem alavancagem, não tem promessa de "
        "rendimento fixo, não tem ninguém prometendo te pagar com o dinheiro do próximo. "
        "No pior caso, vira um zumbi silencioso. Nunca vira um Ponzi que colapsa e leva "
        "todo mundo junto. Essa é a diferença entre engenharia e cassino.")

# =====================================================================
# SLIDE 14 — O QUE FALTA
# =====================================================================
s = slide()
kicker(s, "O que falta para lançar")
txt(s, Inches(0.9), Inches(1.6), Inches(11.5), Inches(1.0),
    "Somos honestos sobre o estágio.", 34, color=FG, bold=True)
todo = [
    ("Auditoria externa", "código pronto, 800+ testes — falta o selo de terceiros"),
    ("App âncora", "um primeiro app com demanda real que puxa o ecossistema"),
    ("Seed de liquidez", "$200k–$500k para dar profundidade ao mercado"),
]
y = Inches(3.1)
for i, (h, d) in enumerate(todo):
    ry = y + (Inches(1.05)) * i
    card(s, Inches(0.9), ry, Inches(11.5), Inches(0.9))
    txt(s, Inches(1.3), ry, Inches(3.6), Inches(0.9), h, 22, color=ACCENT, bold=True, anchor=MSO_ANCHOR.MIDDLE)
    txt(s, Inches(5.1), ry, Inches(7.0), Inches(0.9), d, 17, color=FG, anchor=MSO_ANCHOR.MIDDLE, spacing=1.05)
txt(s, Inches(0.9), Inches(6.5), Inches(11.5), Inches(0.6),
    "Estágio: pré-deploy. Código completo e testado.", 18, color=MUTED, italic=True)
note(s, "Onde estamos? Pré-lançamento, e vou ser transparente sobre o que falta. Falta "
        "auditoria externa — o código está pronto, com mais de 800 testes automatizados, "
        "mas queremos o selo de um terceiro. Falta um app âncora, um primeiro grande caso "
        "de uso que puxe o resto. E falta o capital inicial de liquidez, entre 200 e 500 "
        "mil dólares. Não estamos vendendo um sonho pronto. Estamos mostrando uma "
        "engenharia pronta, esperando os três ingredientes finais.")

# =====================================================================
# SLIDE 15 — A VISAO
# =====================================================================
s = slide()
accent_bar(s, Inches(0.9), Inches(2.2), w=Inches(1.4), h=Inches(0.12))
txt(s, Inches(0.9), Inches(2.5), Inches(11.7), Inches(2.0),
    "Uso real → escassez real → valor real.", 44, color=FG, bold=True, spacing=1.05)
txt(s, Inches(0.9), Inches(4.6), Inches(11.3), Inches(1.8),
    "Uma economia onde o cliente é sócio,\no app é pago para participar,\ne a moeda fica mais escassa a cada uso.",
    24, color=ACCENT, spacing=1.25)
note(s, "Se eu tiver que resumir em cinco palavras: uso real, escassez real, valor real. "
        "Uma economia onde o cliente não é ordenhado, é sócio. Onde o app não é taxado, é "
        "pago pra participar. E onde a moeda, em vez de inflar como toda moeda que você "
        "conhece, fica mais escassa cada vez que alguém a usa de verdade. Isso não existe "
        "hoje. Mas está construído, testado, e esperando.")

# =====================================================================
# SLIDE 16 — ENCERRAMENTO
# =====================================================================
s = slide()
txt(s, Inches(0.9), Inches(2.35), Inches(11.5), Inches(1.0),
    "Web3Community", 40, color=ACCENT, bold=True)
txt(s, Inches(0.9), Inches(3.5), Inches(11.5), Inches(2.0),
    "A pergunta não é se as pessoas vão usar cripto.\nÉ se vão perceber que estão usando.",
    32, color=FG, bold=True, spacing=1.15)
txt(s, Inches(0.9), Inches(6.4), Inches(11.5), Inches(0.6),
    "Obrigado.  Vamos conversar.", 20, color=MUTED, italic=True)
note(s, "Vou terminar com a mesma provocação do começo, virada do avesso. A pergunta que "
        "importa não é se as pessoas vão adotar cripto. É se elas vão perceber que já "
        "estão usando — quando a Bia paga nove reais no Pix e ganha imagens mais baratas, "
        "ela não está pensando em blockchain. Está só vivendo. A melhor tecnologia é a "
        "que desaparece. Obrigado. Vamos conversar.")

# ---------- salvar ----------
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(OUT_DIR, "web3community-modelo-de-negocio.pptx")
prs.save(OUT)

# ---------- verificacao ----------
check = Presentation(OUT)
n = len(check.slides)
print(f"Slides gerados: {n}")
assert n == 16, f"esperado 16 slides, obtido {n}"
for i, sl in enumerate(check.slides, 1):
    texts = []
    for sh in sl.shapes:
        if sh.has_text_frame and sh.text_frame.text.strip():
            texts.append(sh.text_frame.text.strip().split("\n")[0][:55])
    head = texts[0] if texts else "(sem texto)"
    has_notes = bool(sl.has_notes_slide and sl.notes_slide.notes_text_frame.text.strip())
    print(f"  {i:2d}. {head:<57} | notes: {'sim' if has_notes else 'NAO'}")
print(f"\nArquivo: {OUT}")
