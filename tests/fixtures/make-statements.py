# Makes the statement PDFs the tests read (python3 tests/fixtures/make-statements.py).
# They are invented examples in the shape of a GCash transaction history (password-protected, header on
# every page, a wrapped description) and a generic bank statement (header on page 1 only, signed amounts,
# newest first). Needs reportlab and pypdf.
from io import BytesIO
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter

HERE = Path(__file__).parent
W, H = A4

def gcash():
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    rows = [
        [('2026-10-01 09:15 AM', 'Received GCash from JUAN DELA CRUZ', '1001234567890', '', '1,000.00', '6,000.00')],
        [('2026-10-03 12:41 PM', 'Payment to JOLLIBEE FOODS CORP', '1001234567891', '289.00', '', '5,711.00')],
        [('2026-10-05 07:30 PM', 'Buy Load Transaction for', '1001234567892', '100.00', '', '5,611.00'), ('', 'Globe Prepaid 09171234567', '', '', '', '')],
        [('2026-10-08 06:02 PM', 'Transfer to GoTyme Bank', '1001234567893', '1,000.00', '', '4,611.00')],
        None,  # page break
        [('2026-10-10 11:20 AM', 'Payment to MERALCO', '1001234567894', '1,520.50', '', '3,090.50')],
        [('2026-10-12 08:00 AM', 'Cash In from BPI', '1001234567895', '', '2,000.00', '5,090.50')],
    ]
    def head(y):
        c.setFont('Helvetica-Bold', 8)
        for x, t in [(40, 'Date and Time'), (140, 'Description'), (330, 'Reference No.')]: c.drawString(x, y, t)
        for x, t in [(460, 'Debit'), (510, 'Credit'), (560, 'Balance')]: c.drawRightString(x, y, t)
        c.setFont('Helvetica', 8)
    c.setFont('Helvetica-Bold', 14); c.drawString(40, H - 50, 'GCash Transaction History')
    c.setFont('Helvetica', 9); c.drawString(40, H - 66, 'Juan Dela Cruz  0917 *** 4567   Oct 1, 2026 - Oct 12, 2026')
    c.drawString(40, H - 90, 'STARTING BALANCE'); c.drawRightString(560, H - 90, '5,000.00')
    y = H - 115; head(y); y -= 16
    for r in rows:
        if r is None:
            c.drawString(40, 30, 'Page 1 of 2'); c.showPage(); y = H - 60; head(y); y -= 16; continue
        for (d, desc, ref, dr, cr, bal) in r:
            c.drawString(40, y, d); c.drawString(140, y, desc); c.drawString(330, y, ref)
            for x, t in [(460, dr), (510, cr), (560, bal)]:
                if t: c.drawRightString(x, y, t)
            y -= 12
        y -= 4
    c.drawString(40, y - 10, 'ENDING BALANCE'); c.drawRightString(560, y - 10, '5,090.50')
    c.drawString(40, 30, 'Page 2 of 2')
    c.save()
    w = PdfWriter(clone_from=PdfReader(BytesIO(buf.getvalue())))
    w.encrypt(user_password='pitaka1234', owner_password=None, algorithm='AES-128')
    out = BytesIO(); w.write(out)
    (HERE / 'statement-gcash.pdf').write_bytes(out.getvalue())

def bank():
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont('Helvetica-Bold', 13); c.drawString(40, H - 50, 'Statement of Account')
    c.setFont('Helvetica', 9); c.drawString(40, H - 64, 'Savings Account ****1234  Period: September 2026')
    y = H - 100
    c.setFont('Helvetica-Bold', 9)
    c.drawString(40, y, 'Transaction Date'); c.drawString(150, y, 'Details'); c.drawRightString(450, y, 'Amount'); c.drawRightString(550, y, 'Running Balance')
    c.setFont('Helvetica', 9); y -= 16
    rows = [('Sep 30, 2026', 'ATM WITHDRAWAL SM MEGAMALL', '-2,000.00', '23,452.25'), ('Sep 25, 2026', 'PAYROLL ACME CORP', '25,000.00', '25,452.25'),
            ('Sep 20, 2026', 'POS NETFLIX.COM', '-549.00', '452.25'), ('Sep 15, 2026', 'INTEREST EARNED', '1.25', '1,001.25')]
    for r in rows:
        c.drawString(40, y, r[0]); c.drawString(150, y, r[1]); c.drawRightString(450, y, r[2]); c.drawRightString(550, y, r[3]); y -= 14
    c.drawString(40, 30, 'This is a system-generated statement.')
    c.save()
    (HERE / 'statement-bank.pdf').write_bytes(buf.getvalue())

gcash()
bank()
print('ok')
