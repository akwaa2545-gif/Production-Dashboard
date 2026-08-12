# รายงานตรวจสอบยอด PSL B2 วันที่ 18-Jul-2026

## สรุปผล

ยอด `PSL B2` ใน Web และ Excel ต่างกัน `14,000` หน่วย เนื่องจากกติกาการจัดกลุ่ม Series ไม่เหมือนกัน

| รายการ | จำนวน Complete Qty |
|---|---:|
| Web Dashboard | 1,144,000 |
| Excel / CSV | 1,130,000 |
| ผลต่าง | 14,000 |

## เงื่อนไขที่ใช้ตรวจสอบ

- Data source: `PowerBIThailand.ClosedBatch_v`
- วันที่: `CloseDate = 2026-07-18`
- Product: `NEO`
- Series: `PSL B2`
- End Operation: `DummyEnd`
- ไม่รวม ProdLine: `Semi-Finished Good apply in Racking (BoL)`

## สาเหตุของผลต่าง

ในฐานข้อมูลปัจจุบันมี 1 รายการที่ `Series` ว่าง แต่ Web Dashboard แปลงชื่อ Series จาก `ProdLine` สำหรับข้อมูล NEO จึงถูกจัดเข้า Series `PSL B2`

| Field | ค่า |
|---|---|
| Series | ว่าง |
| ProdLine | `Ta NEO Capacitor PSL series B2 case` |
| PartNumber | `TEPSLB20J157M18HF8R` |
| CompleteQty | 14,000 |
| EndOperation | `DummyEnd` |

Web Dashboard ใช้กติกา fallback ดังนี้:

```text
Series ว่าง + ProdLine = Ta NEO Capacitor PSL series B2 case
=> แสดงเป็น PSL B2
```

ไฟล์ Excel/CSV ใช้เฉพาะแถวที่ค่า `Series = PSL B2` โดยตรง จึงไม่รวมแถว Series ว่างจำนวน 14,000 หน่วย

## ข้อสรุป

- ยอด Excel `1,130,000` ถูกต้องตามกติกา "ใช้ Series ที่มีค่าโดยตรงเท่านั้น"
- ยอด Web `1,144,000` ถูกต้องตามกติกา Dashboard ปัจจุบันที่แปลง Series ว่างจาก ProdLine
- หากต้องการให้ Web ตรงกับ Excel ต้องไม่ใช้ ProdLine เพื่อแทนค่า Series ว่างในการรวมยอด Completion 901 ของ NEO

## ข้อเสนอแนะ

แยกกติกา Series สำหรับรายงาน 901:

- ตาราง/กราฟ/Export ที่ต้องตรงกับ Excel: ใช้ `Series` จาก Closed Batch โดยตรง และไม่รวม Series ว่างใน PSL B2
- ส่วนที่ต้องการวิเคราะห์ตระกูลสินค้า: สามารถใช้ ProdLine fallback ต่อไปได้ แต่ควรแสดงว่าเป็น "Derived Series"
