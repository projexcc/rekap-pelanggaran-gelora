/**
 * SMP-SMK Gelora — modul Export Excel (lazy-loaded)
 * Dipanggil hanya saat user menekan Export.
 * Bergantung pada: records, filterBySchoolMode, getGroups, escapeHtml, dll. di smpgelora.js
 */
(function (global) {
'use strict';

/* Data poin selalu disegarkan dari Supabase saat export, bukan hanya mengandalkan cache layar. */
let exportPointItemsByRecord = new Map();
let exportOfficialRulesFromDb = [];
async function loadExportMappingData(){
    if (typeof _supabase === 'undefined' || !_supabase) throw new Error('Koneksi database belum tersedia untuk membaca aturan poin.');
    const rulesResult = await _supabase
        .from('violation_point_rules')
        .select('code,name,points,severity,accumulation_scope,active')
        .order('code', {ascending:true});
    if (rulesResult.error) throw rulesResult.error;
    exportOfficialRulesFromDb = Array.isArray(rulesResult.data) ? rulesResult.data : [];

    exportPointItemsByRecord = new Map();
    let from = 0;
    const pageSize = 1000;
    while (true) {
        const result = await _supabase
            .from('pelanggaran_point_items')
            .select('id,pelanggaran_id,violation_code,points_snapshot,severity_snapshot,accumulation_scope_snapshot')
            .order('id', {ascending:true})
            .range(from, from + pageSize - 1);
        if (result.error) throw result.error;
        const rows = Array.isArray(result.data) ? result.data : [];
        rows.forEach(row => {
            const key = String(row.pelanggaran_id ?? '');
            if (!key) return;
            if (!exportPointItemsByRecord.has(key)) exportPointItemsByRecord.set(key, []);
            exportPointItemsByRecord.get(key).push(row);
        });
        if (rows.length < pageSize) break;
        from += pageSize;
    }
}
function getExportPointItems(recordId){
    const key = String(recordId ?? '');
    const fresh = exportPointItemsByRecord.get(key);
    if (fresh) return fresh;
    try { return typeof getRecordPointItems === 'function' ? (getRecordPointItems(recordId) || []) : []; }
    catch (_) { return []; }
}

/* EXPORT SISWA DENGAN PELANGGARAN BERULANG ATAU PELANGGARAN BERAT */
function hasHeavyPointRecord(record){
    let items = [];
    try {
        items = getExportPointItems(record && record.id);
    } catch (_) {}
    return Array.isArray(items) && items.some(item => {
        const severity = String(item.severity_snapshot || '').trim().toLowerCase();
        const code = String(item.violation_code || '').trim().toUpperCase();
        return severity === 'berat' || /^B(?:[1-9]|1[0-5])$/.test(code);
    });
}

function getThreeStrikeOrHeavyStudents(tahunAjaran){
    const targetTA = normTA(
        tahunAjaran ||
        document.getElementById('report-tahun-ajaran')?.value ||
        getDefaultTahunAjaranSemester().tahunAjaran
    );
    const groups = new Map();
    filterBySchoolMode(records).forEach(item => {
        const nama = String(item.nama || '').trim();
        if (!nama) return;
        const ta = String(item.tahun_ajaran || '').trim();
        if (targetTA && normTA(ta) !== targetTA) return;
        const key = `${normalizeName(nama)}__${normTA(ta)}`;
        if (!groups.has(key)) groups.set(key, {
            nama,
            kelas: String(item.kelas || '').trim() || '-',
            kelasList: [],
            records: [],
            tahun_ajaran: ta || targetTA
        });
        const group = groups.get(key);
        group.records.push(item);
        const kelas = String(item.kelas || '').trim();
        if (kelas && !group.kelasList.some(k => normalizeName(k) === normalizeName(kelas))) group.kelasList.push(kelas);
        if (hasHeavyPointRecord(item)) group.hasHeavyViolation = true;
    });
    return [...groups.values()].map(g => {
        const latest = [...g.records].sort((a,b) =>
            String(b.tanggal || '').localeCompare(String(a.tanggal || '')) || Number(b.id || 0) - Number(a.id || 0)
        )[0];
        g.kelas = String(latest?.kelas || g.kelas || '-').trim() || '-';
        return g;
    }).filter(g => g.records.length >= 3 || g.hasHeavyViolation)
      .sort((a,b) => b.records.length - a.records.length || a.nama.localeCompare(b.nama, 'id'));
}
function getExportChartGroups(data, filterType){
    if (filterType !== 'klasifikasi' && filterType !== 'aturan') return getGroups(data, filterType);
    const groups = new Map();
    const rulesByCode = new Map(exportOfficialRulesFromDb.map(rule => [String(rule.code), rule]));
    (Array.isArray(data) ? data : []).forEach(record => {
        const items = exportPointItemsByRecord.get(String(record.id ?? '')) || [];
        if (!items.length) {
            groups.set('Belum Dipetakan', (groups.get('Belum Dipetakan') || 0) + 1);
            return;
        }
        items.forEach(item => {
            const code = String(item.violation_code || '').trim();
            const rule = rulesByCode.get(code);
            let label;
            if (filterType === 'aturan') {
                label = code ? `${code} — ${rule?.name || 'Aturan historis'}` : 'Aturan tidak diketahui';
            } else {
                const severity = String(item.severity_snapshot || rule?.severity || '').trim().toLowerCase();
                label = ['ringan','sedang','berat'].includes(severity) ? severity[0].toUpperCase() + severity.slice(1) : 'Belum Dipetakan';
            }
            groups.set(label, (groups.get(label) || 0) + 1);
        });
    });
    const result = [...groups.entries()];
    if (filterType === 'klasifikasi') {
        const order = ['Berat','Sedang','Ringan','Belum Dipetakan'];
        return result.sort((a,b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    }
    return result.sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0], 'id'));
}

async function imageUrlToDataUri(url){
    if(!url) return null;
    try{
        const response = await fetch(url, {mode:'cors'});
        if(!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return await new Promise((resolve,reject)=>{
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }catch(err){
        console.warn('Foto tidak dapat dimasukkan ke Excel:', url, err);
        return null;
    }
}

async function exportThreeStrikeReport(){
    try { await loadExportMappingData(); } catch (error) { console.error('Gagal memuat data poin dari database:', error); return Swal.fire({icon:'error',title:'Gagal Memuat Poin',text:'Laporan dihentikan karena aturan resmi/snapshot poin tidak berhasil dimuat. Periksa koneksi database lalu coba lagi.',confirmButtonColor:'#e53935'}); }
    const students = getThreeStrikeOrHeavyStudents();

    if(!students.length){
        return Swal.fire({
            icon:'info',
            title:'Report Kosong',
            text:'Belum ada siswa dengan 3x+ pelanggaran atau pelanggaran kategori Berat.',
            confirmButtonColor:'#f97316'
        });
    }

    Swal.fire({
        title:'Mengeksport Report Pelanggaran...',
        html:'Menyiapkan siswa dengan 3x+ pelanggaran atau minimal satu pelanggaran kategori Berat.',
        allowOutsideClick:false,
        didOpen:()=>Swal.showLoading()
    });

    try{
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('REPORT TINDAK LANJUT');

        const { tahunAjaran: defaultTA3 } = getDefaultTahunAjaranSemester();
        const taLabel3 = (typeof getAvailableTahunAjaranList === 'function' && getAvailableTahunAjaranList().length)
            ? getAvailableTahunAjaranList()[0]
            : defaultTA3;

        ws.mergeCells('A1:J1');
        ws.mergeCells('A2:J2');
        ws.mergeCells('A3:J3');
        ws.getCell('A1').value = 'REPORT TINDAK LANJUT — 3+ PELANGGARAN ATAU KATEGORI BERAT (' + getSchoolModeLabel() + ')';
        ws.getCell('A2').value = 'SMP - SMK GELORA BEKASI';
        ws.getCell('A3').value = 'Tahun Ajaran ' + String(taLabel3 || defaultTA3).replace(/\//g, '-');

        ['A1','A2','A3'].forEach((cell,i)=>{
            ws.getCell(cell).font = {
                name:'Arial',
                size:i===0?14:i===1?12:10,
                bold:true,
                color: { argb: i === 0 ? '0F172A' : '334155' }
            };
            ws.getCell(cell).alignment = {
                horizontal:'center',
                vertical:'middle'
            };
        });
        ws.getRow(1).height = 22;
        ws.getRow(2).height = 18;
        ws.getRow(3).height = 16;

        // Header langsung baris 4 (tanpa baris kosong)
        const header = ws.addRow([
            'No','Foto Bukti Terbaru','Nama Siswa','Kelas','Total Pelanggaran',
            'Status Tindak Lanjut','Tanggal Tindakan','Ditindak Oleh',
            'Catatan','Riwayat Pelanggaran'
        ]);
        header.height = 22;

        header.eachCell(cell=>{
            cell.fill = {
                type:'pattern',
                pattern:'solid',
                fgColor:{argb:'C2410C'}
            };
            cell.font = {name:'Arial', bold:true, color:{argb:'FFFFFF'}, size:10};
            cell.alignment = {
                horizontal:'center',
                vertical:'middle',
                wrapText:true
            };
            cell.border = {
                top:{style:'thin'},
                left:{style:'thin'},
                bottom:{style:'thin'},
                right:{style:'thin'}
            };
        });

        [6,14,26,12,14,22,14,18,28,48]
            .forEach((w,i)=>ws.getColumn(i+1).width=w);

        ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 4, topLeftCell: 'A5', activeCell: 'A5' }];

        let no = 0;

        for(const g of students){
            no++;

            const {key, follow} = getThreeStrikeFollowUp(g);

            const sorted = [...g.records].sort((a,b)=>
                String(a.tanggal||'').localeCompare(String(b.tanggal||'')) ||
                Number(a.id||0) - Number(b.id||0)
            );

            const latestWithPhoto = [...sorted]
                .reverse()
                .find(r => r.foto_url) || null;

            const riwayat = sorted
                .map((r,n)=>
                    `${n+1}. ${r.pelanggaran||'-'} — ${formatTanggalIndonesia(r.tanggal)||'-'}`
                )
                .join('\n');

            const row = ws.addRow([
                no,
                '',
                g.nama || '-',
                g.kelas || '-',
                g.records.length,
                follow.status || 'Belum Ditindak',
                follow.tanggal ? formatTanggalIndonesia(follow.tanggal) : '-',
                follow.oleh || '-',
                follow.catatan || '-',
                riwayat || '-'
            ]);

            row.height = Math.max(
                70,
                Math.min(180, 18 * Math.max(3, riwayat.split('\n').length))
            );

            row.eachCell({includeEmpty:true},cell=>{
                cell.alignment = {
                    vertical:'top',
                    horizontal:'left',
                    wrapText:true
                };
                cell.border = {
                    top:{style:'thin'},
                    left:{style:'thin'},
                    bottom:{style:'thin'},
                    right:{style:'thin'}
                };
            });

            [1,4,5,6].forEach(c=>{
                row.getCell(c).alignment = {
                    vertical:'top',
                    horizontal:'center',
                    wrapText:true
                };
            });

            if(latestWithPhoto){
                const dataUri = await imageUrlToDataUri(latestWithPhoto.foto_url);

                if(dataUri){
                    const ext = dataUri.startsWith('data:image/png')
                        ? 'png'
                        : 'jpeg';

                    const imageId = workbook.addImage({
                        base64:dataUri,
                        extension:ext
                    });

                    ws.addImage(imageId,{
                        tl:{col:1.15,row:row.number-0.85},
                        ext:{width:95,height:75}
                    });
                }else{
                    row.getCell(2).value = 'Foto gagal dimuat';
                }
            }else{
                row.getCell(2).value = 'Tidak ada foto';
            }
        }

        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer],{
            type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `Report_3x_Pelanggaran_${getSchoolModeLabel().replace(/\s+/g,'_')}_Gelora_${getLocalDateISO()}.xlsx`;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(()=>URL.revokeObjectURL(url),1000);

        Swal.fire({
            icon:'success',
            title:'Berhasil Export',
            text:`${students.length} siswa dengan 3x+ pelanggaran atau pelanggaran kategori Berat berhasil dimasukkan ke Excel.`,
            confirmButtonColor:'#21a366'
        });

    }catch(err){
        console.error(err);
        Swal.fire({
            icon:'error',
            title:'Export Gagal',
            text:'Terjadi kesalahan saat export: '+err.message,
            confirmButtonColor:'#e53935'
        });
    }
}


async function addNativeExcelCharts(xlsxBuffer, chartConfigs){
    if(typeof JSZip === 'undefined'){
        throw new Error('JSZip belum tersedia untuk membuat chart Excel native.');
    }
    if(!Array.isArray(chartConfigs) || !chartConfigs.length) return xlsxBuffer;

    const zip = await JSZip.loadAsync(xlsxBuffer);
    const sheetXmlPath = 'xl/worksheets/sheet1.xml';
    const relsPath = 'xl/worksheets/_rels/sheet1.xml.rels';
    const sheetXml = await zip.file(sheetXmlPath).async('string');
    const sheetRelsXml = await zip.file(relsPath).async('string');
    const drawingMatch = sheetXml.match(/<drawing[^>]*r:id="([^"]+)"[^>]*\/>/);
    if(!drawingMatch) throw new Error('Drawing Excel tidak ditemukan.');

    const drawingRelId = drawingMatch[1];
    const drawingRelRegex = new RegExp('<Relationship[^>]*Id="'+drawingRelId+'"[^>]*Target="([^"]+)"[^>]*/>');
    const drawingRelMatch = sheetRelsXml.match(drawingRelRegex);
    if(!drawingRelMatch) throw new Error('Relasi drawing Excel tidak ditemukan.');

    const drawingTarget = drawingRelMatch[1].replace(/^\.\.\//,'');
    const drawingPath = drawingTarget.startsWith('xl/') ? drawingTarget : 'xl/' + drawingTarget;
    const drawingRelsPath = drawingPath.replace(/([^/]+)$/, '_rels/$1.rels');
    let drawingXml = await zip.file(drawingPath).async('string');
    let drawingRelsXml = zip.file(drawingRelsPath)
        ? await zip.file(drawingRelsPath).async('string')
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

    const esc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
    const existingRIds = Array.from(drawingRelsXml.matchAll(/Id="rId(\d+)"/g)).map(m => Number(m[1]));
    let nextRidNum = (existingRIds.length ? Math.max(...existingRIds) : 0) + 1;
    const chartNumsExisting = Object.keys(zip.files).map(k => { const m=k.match(/^xl\/charts\/chart(\d+)\.xml$/); return m?Number(m[1]):0; }).filter(Boolean);
    let chartNum = (chartNumsExisting.length ? Math.max(...chartNumsExisting) : 0) + 1;
    let frameId = 1000 + chartNum;

    let contentTypes = await zip.file('[Content_Types].xml').async('string');
    const colLetters = n => { let out=''; while(n>0){ let r=(n-1)%26; out=String.fromCharCode(65+r)+out; n=Math.floor((n-1)/26); } return out; };

    for(const cfg of chartConfigs){
        const labels = Array.isArray(cfg.labels) ? cfg.labels.map(v=>String(v ?? '')) : [];
        const values = Array.isArray(cfg.values) ? cfg.values.map(v=>Number(v)||0) : [];
        if(!labels.length) continue;

        const chartPath = `xl/charts/chart${chartNum}.xml`;
        const catCol = colLetters(cfg.catCol);
        const valCol = colLetters(cfg.valCol);
        const catFormula = `'Rekap Pelanggaran'!$${catCol}$${cfg.dataStart}:$${catCol}$${cfg.dataStart + labels.length - 1}`;
        const valFormula = `'Rekap Pelanggaran'!$${valCol}$${cfg.dataStart}:$${valCol}$${cfg.dataStart + values.length - 1}`;
        const catPts = labels.map((label,i)=>`<c:pt idx="${i}"><c:v>${esc(label)}</c:v></c:pt>`).join('');
        const numPts = values.map((v,i)=>`<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('');
        const chartType = cfg.chartType || 'bar';
        const isLine = chartType === 'line';
        const isPie = chartType === 'pie';
        const seriesLabel = cfg.seriesLabel || 'Jumlah';
        const barOrLine = isPie ? `<c:pieChart><c:varyColors val="1"/>` : isLine ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>` : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="1"/>`;
        const endChart = isPie ? `</c:pieChart>` : isLine ? `</c:lineChart>` : `</c:barChart>`;
        const extra = isPie ? '' : isLine
            ? `<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="3B82F6"/></a:solidFill></a:ln></c:spPr><c:smooth val="0"/>`
            : `<c:invertIfNegative val="0"/>`;
        const axes = isPie ? '' : `<c:catAx><c:axId val="-201"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="-202"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="-202"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="0" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="-201"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;

        // Excel desktop mengharapkan kedua axis ID berada DI DALAM chart type
        // (barChart/lineChart), bukan hanya di plotArea. WPS lebih toleran,
        // sehingga file lama bisa terlihat normal di WPS tetapi tidak di Excel.
        const chartAxisIds = isPie
            ? ''
            : '<c:axId val="-201"/><c:axId val="-202"/>';

        const chartXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:date1904 val="0"/><c:lang val="id-ID"/><c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="0"/>
<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="id-ID" sz="1400" b="1"/><a:t>${esc(cfg.title)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title>
<c:plotArea><c:layout/>${barOrLine}
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>'Rekap Pelanggaran'!$${valCol}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(seriesLabel)}</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:f>${catFormula}</c:f><c:strCache><c:ptCount val="${labels.length}"/>${catPts}</c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>${valFormula}</c:f><c:numCache><c:formatCode>0</c:formatCode><c:ptCount val="${values.length}"/>${numPts}</c:numCache></c:numRef></c:val>
${extra}</c:ser>${chartAxisIds}${endChart}${axes}</c:plotArea>${isPie ? '<c:legend><c:legendPos val="b"/><c:layout/><c:overlay val="0"/></c:legend>' : ''}<c:plotVisOnly val="0"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart></c:chartSpace>`;
        zip.file(chartPath, chartXml);

        const rid = 'rId' + nextRidNum++;
        drawingRelsXml = drawingRelsXml.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartNum}.xml"/></Relationships>`);

        const row1 = cfg.anchorRow;
        const row2 = cfg.anchorRow + (cfg.heightRows || 15);
        const col1 = cfg.anchorCol ?? 10;
        const col2 = cfg.anchorColEnd ?? 18;
        const anchor = `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${col1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col2}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row2}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${frameId++}" name="Chart ${chartNum}"/><xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
        drawingXml = drawingXml.replace('</xdr:wsDr>', anchor + '</xdr:wsDr>');

        if(!contentTypes.includes(`PartName="/xl/charts/chart${chartNum}.xml"`)){
            contentTypes = contentTypes.replace('</Types>', `<Override PartName="/xl/charts/chart${chartNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
        }
        chartNum++;
    }

    zip.file(drawingRelsPath, drawingRelsXml);
    zip.file(drawingPath, drawingXml);
    zip.file('[Content_Types].xml', contentTypes);
    return await zip.generateAsync({type:'arraybuffer', compression:'DEFLATE'});
}

async function exportToExcel(){
    if(!records.length) return Swal.fire({
        icon: 'info',
        title: 'Data Kosong',
        text: 'Tidak ada data untuk diexport!',
        confirmButtonColor: '#f97316'
    });

    try { await loadExportMappingData(); } catch (error) {
        console.error('Gagal memuat aturan/snapshot poin dari database:', error);
        return Swal.fire({icon:'error', title:'Gagal Memuat Poin', text:'Export dihentikan agar status jenis dan poin tidak keliru. Periksa koneksi database lalu coba lagi.', confirmButtonColor:'#e53935'});
    }

    // Kumpulkan tahun ajaran unik dari data (mode jenjang aktif)
    const scopedForOptions = filterBySchoolMode(records);
    const tahunList = getAvailableTahunAjaranList();
    const { tahunAjaran: defaultTA } = getDefaultTahunAjaranSemester();
    const now = new Date();
    const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const tahunOptions = tahunList.map(ta =>
        `<option value="${escapeAttr(ta)}" ${normTA(ta) === normTA(defaultTA) ? 'selected' : ''}>${escapeHtml(ta)}</option>`
    ).join('');

    const { value: formValues } = await Swal.fire({
        title: '📗 Export ke Excel',
        html: `
            <div style="text-align: left; font-size: 13px;">
                <label style="font-weight: bold; display: block; margin-bottom: 4px;">Mode Filter:</label>
                <select id="swal-export-mode" class="swal2-input" style="margin: 0 0 12px 0; width: 100%;">
                    <option value="ta_sem" selected>Tahun Ajaran + Semester</option>
                    <option value="bulan">Per Bulan</option>
                    <option value="tanggal">Rentang Tanggal</option>
                </select>

                <div id="swal-export-box-ta">
                    <label style="font-weight: bold; display: block; margin-bottom: 4px;">Tahun Ajaran:</label>
                    <select id="swal-export-ta" class="swal2-input" style="margin: 0 0 12px 0; width: 100%;">
                        ${tahunOptions}
                    </select>
                    <label style="font-weight: bold; display: block; margin-bottom: 4px;">Semester:</label>
                    <select id="swal-export-sem" class="swal2-input" style="margin: 0 0 4px 0; width: 100%;">
                        <option value="all" selected>Semua Semester</option>
                        <option value="Ganjil">Ganjil</option>
                        <option value="Genap">Genap</option>
                    </select>
                </div>

                <div id="swal-export-box-bulan" style="display:none;">
                    <label style="font-weight: bold; display: block; margin-bottom: 4px;">Bulan:</label>
                    <input id="swal-export-bulan" type="month" class="swal2-input" value="${defaultMonth}" style="margin: 0 0 4px 0; width: 100%;">
                </div>

                <div id="swal-export-box-tanggal" style="display:none;">
                    <label style="font-weight: bold; display: block; margin-bottom: 4px;">Dari Tanggal:</label>
                    <input id="swal-export-from" type="date" class="swal2-input" style="margin: 0 0 10px 0; width: 100%;">
                    <label style="font-weight: bold; display: block; margin-bottom: 4px;">Sampai Tanggal:</label>
                    <input id="swal-export-to" type="date" class="swal2-input" style="margin: 0 0 4px 0; width: 100%;">
                </div>

                <p style="font-size:11px; color:#64748b; margin:8px 0 0;">Sheet 2 hanya memuat siswa dengan minimal 3 pelanggaran dalam satu Tahun Ajaran. Riwayat mengikuti periode yang dipilih; kode/poin mengacu pada daftar resmi. Foto/dokumen bukti ikut disisipkan jika tersedia.</p>
            </div>
        `,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: '📥 Export Sekarang',
        cancelButtonText: 'Batal',
        confirmButtonColor: '#f97316',
        didOpen: () => {
            const modeEl = document.getElementById('swal-export-mode');
            const boxTa = document.getElementById('swal-export-box-ta');
            const boxBulan = document.getElementById('swal-export-box-bulan');
            const boxTgl = document.getElementById('swal-export-box-tanggal');
            const sync = () => {
                const m = modeEl.value;
                boxTa.style.display = m === 'ta_sem' ? '' : 'none';
                boxBulan.style.display = m === 'bulan' ? '' : 'none';
                boxTgl.style.display = m === 'tanggal' ? '' : 'none';
            };
            modeEl.addEventListener('change', sync);
            sync();
        },
        preConfirm: () => {
            const mode = document.getElementById('swal-export-mode').value;
            if (mode === 'ta_sem') {
                const tahunAjaran = document.getElementById('swal-export-ta').value;
                const semester = document.getElementById('swal-export-sem').value;
                if (!tahunAjaran) {
                    Swal.showValidationMessage('Pilih tahun ajaran!');
                    return false;
                }
                return { mode, tahunAjaran, semester };
            }
            if (mode === 'bulan') {
                const bulan = document.getElementById('swal-export-bulan').value;
                if (!bulan || !/^\d{4}-\d{2}$/.test(bulan)) {
                    Swal.showValidationMessage('Pilih bulan!');
                    return false;
                }
                return { mode, bulan };
            }
            const from = document.getElementById('swal-export-from').value;
            const to = document.getElementById('swal-export-to').value;
            if (!from || !to) {
                Swal.showValidationMessage('Isi rentang tanggal lengkap!');
                return false;
            }
            if (from > to) {
                Swal.showValidationMessage('Tanggal mulai tidak boleh setelah tanggal akhir!');
                return false;
            }
            return { mode, from, to };
        }
    });

    if (!formValues) return;

    const filteredRecords = filterBySchoolMode(records).filter(item => {
        const tgl = String(item.tanggal || '').substring(0, 10);
        if (formValues.mode === 'ta_sem') {
            const itemTA = normTA(item.tahun_ajaran);
            if (!itemTA || itemTA !== normTA(formValues.tahunAjaran)) return false;
            if (formValues.semester && formValues.semester !== 'all') {
                const sem = String(item.semester || '').trim().toLowerCase();
                if (sem !== formValues.semester.toLowerCase()) return false;
            }
            return true;
        }
        if (formValues.mode === 'bulan') {
            return tgl.startsWith(formValues.bulan);
        }
        if (!tgl) return false;
        return tgl >= formValues.from && tgl <= formValues.to;
    });

    if (!filteredRecords.length) {
        let msg = 'Tidak ada data untuk filter yang dipilih.';
        if (formValues.mode === 'ta_sem') {
            const semLabel = formValues.semester === 'all' ? 'semua semester' : 'Semester ' + formValues.semester;
            msg = `Tidak ada data untuk Tahun Ajaran ${formValues.tahunAjaran} (${semLabel}).`;
        } else if (formValues.mode === 'bulan') {
            msg = `Tidak ada data untuk bulan ${formValues.bulan}.`;
        } else {
            msg = `Tidak ada data pada ${formValues.from} s/d ${formValues.to}.`;
        }
        return Swal.fire({
            icon: 'warning',
            title: 'Data Tidak Ditemukan',
            text: msg,
            confirmButtonColor: '#f97316'
        });
    }

    let periodeLabel, fileTA, fileSem;
    if (formValues.mode === 'ta_sem') {
        periodeLabel = formValues.semester === 'all'
            ? `Tahun Ajaran ${formValues.tahunAjaran} · Semua Semester`
            : `Tahun Ajaran ${formValues.tahunAjaran} · Semester ${formValues.semester}`;
        fileTA = String(formValues.tahunAjaran).replace(/[\/]/g, '-');
        fileSem = formValues.semester === 'all' ? 'Semua' : formValues.semester;
    } else if (formValues.mode === 'bulan') {
        const [yy, mm] = formValues.bulan.split('-');
        const namaBulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][Number(mm) - 1] || mm;
        periodeLabel = `Bulan ${namaBulan} ${yy}`;
        fileTA = formValues.bulan;
        fileSem = 'Bulanan';
    } else {
        periodeLabel = `${formatTanggalIndonesia(formValues.from)} s/d ${formatTanggalIndonesia(formValues.to)}`;
        fileTA = `${formValues.from}_${formValues.to}`;
        fileSem = 'Rentang';
    }

    Swal.fire({
        title: 'Mengeksport Data...',
        text: 'Mohon tunggu sebentar',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
    });

    try{
        // PENTING: tulis judul → header → DATA TABEL dulu, baru sumber chart di kolom tersembunyi.
        // Jika sumber chart ditulis lebih dulu via getCell(baris tinggi), ExcelJS menaikkan
        // rowCount sehingga addRow() data terdorong jauh ke bawah (header baris 6, data baris 18+).

        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Rekap Pelanggaran');

        // SMP → tanpa Jurusan (8 kolom); SMK / Semua → dengan Jurusan (9 kolom)
        const showJurusanCol = schoolMode !== 'smp';
        const headerCols = showJurusanCol
            ? ['No','Hari / Tanggal','Nama Siswa','Kelas','Jurusan','Tahun Ajaran','Semester','Jenis Pelanggaran','Foto']
            : ['No','Hari / Tanggal','Nama Siswa','Kelas','Tahun Ajaran','Semester','Jenis Pelanggaran','Foto'];
        const colWidths = showJurusanCol
            ? [6, 16, 26, 12, 12, 13, 11, 28, 12]
            : [6, 16, 26, 12, 13, 11, 28, 12];
        const tableColCount = colWidths.length; // 8 atau 9
        const lastTableColLetter = String.fromCharCode(64 + tableColCount); // H atau I
        const photoColIndex = tableColCount - 1; // 0-based index kolom Foto
        // Chart di kanan tabel (0-based col = tableColCount → kolom setelah terakhir)
        const chartStartCol = tableColCount;
        const spacerCol = tableColCount + 1;

        // ===== JUDUL (rapi, hanya sepanjang kolom tabel) =====
        ws.mergeCells(`A1:${lastTableColLetter}1`);
        ws.mergeCells(`A2:${lastTableColLetter}2`);
        ws.mergeCells(`A3:${lastTableColLetter}3`);
        ws.getCell('A1').value = 'REKAPITULASI PELANGGARAN SISWA/SISWI (' + getSchoolModeLabel() + ')';
        ws.getCell('A2').value = 'SMP - SMK GELORA BEKASI';
        ws.getCell('A3').value = (formValues.mode === 'ta_sem')
            ? ('Tahun Ajaran ' + String(formValues.tahunAjaran || '').replace(/\//g, '-') +
               (formValues.semester && formValues.semester !== 'all' ? ' · Semester ' + formValues.semester : ' · Semua Semester'))
            : periodeLabel;

        ['A1','A2','A3'].forEach((cell, i) => {
            ws.getCell(cell).font = {
                name: 'Arial',
                size: i === 0 ? 14 : i === 1 ? 12 : 10,
                bold: true,
                color: { argb: i === 0 ? '0F172A' : '334155' }
            };
            ws.getCell(cell).alignment = { horizontal: 'center', vertical: 'middle' };
        });
        ws.getRow(1).height = 22;
        ws.getRow(2).height = 18;
        ws.getRow(3).height = 16;

        // ===== HEADER TABEL (langsung baris 4, tanpa baris kosong) =====
        const header = ws.addRow(headerCols);
        header.height = 22;
        header.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E3A5F' } };
            cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFF' }, size: 10 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = {
                top: { style: 'thin', color: { argb: '0F172A' } },
                left: { style: 'thin', color: { argb: '0F172A' } },
                bottom: { style: 'thin', color: { argb: '0F172A' } },
                right: { style: 'thin', color: { argb: '0F172A' } }
            };
        });
        colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

        // Spacer + area grafik di kanan (tidak meniban tabel)
        ws.getColumn(spacerCol).width = 3;
        for (let c = spacerCol + 1; c <= spacerCol + 10; c++) ws.getColumn(c).width = 12;

        // Freeze header agar judul+header tetap terlihat saat scroll
        ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 4, topLeftCell: 'A5', activeCell: 'A5' }];

        // ===== BARIS DATA (langsung di bawah header — baris 5, 6, 7, ...) =====
        for (let i = 0; i < filteredRecords.length; i++) {
            const item = filteredRecords[i];
            const rowData = showJurusanCol
                ? [
                    i + 1,
                    formatTanggalIndonesia(item.tanggal) || '-',
                    item.nama || '-',
                    item.kelas || '-',
                    item.jurusan || '-',
                    item.tahun_ajaran || '-',
                    item.semester || '-',
                    item.pelanggaran || '-',
                    ''
                  ]
                : [
                    i + 1,
                    formatTanggalIndonesia(item.tanggal) || '-',
                    item.nama || '-',
                    item.kelas || '-',
                    item.tahun_ajaran || '-',
                    item.semester || '-',
                    item.pelanggaran || '-',
                    ''
                  ];
            const row = ws.addRow(rowData);
            row.height = 58;
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                cell.font = { name: 'Arial', size: 10 };
                const isTextCol = colNumber === 3 || colNumber === (showJurusanCol ? 8 : 7);
                cell.alignment = {
                    vertical: 'middle',
                    horizontal: isTextCol ? 'left' : 'center',
                    wrapText: true,
                    indent: isTextCol ? 1 : 0
                };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'CBD5E1' } },
                    left: { style: 'thin', color: { argb: 'CBD5E1' } },
                    bottom: { style: 'thin', color: { argb: 'CBD5E1' } },
                    right: { style: 'thin', color: { argb: 'CBD5E1' } }
                };
                if (i % 2 === 1) {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8FAFC' } };
                }
            });
            row._exportFotoUrl = item.foto_url || null;
            row._exportRowNumber = row.number;
        }

        // ===== SUMBER CHART (kolom tersembunyi) — SETELAH data tabel =====
        // Mode SMK: + grafik Per Jurusan; SMP/Semua: tanpa jurusan chart
        const CHART_H = 14;
        const CHART_GAP = 1;
        let nextAnchorRow = 0; // 0-based row untuk anchor chart (sejajar judul, di KANAN tabel)

        function makeChartDef(key, title, chartType, catCol, valCol) {
            const def = {
                key, title, chartType,
                catCol, valCol, dataStart: 2,
                anchorRow: nextAnchorRow,
                heightRows: CHART_H,
                anchorCol: chartStartCol,
                anchorColEnd: chartStartCol + 7
            };
            nextAnchorRow += CHART_H + CHART_GAP;
            return def;
        }

        const chartDefinitions = [
            makeChartDef('klasifikasi', 'Grafik: Klasifikasi Aturan Poin', 'bar', 27, 28),
            makeChartDef('aturan',      'Grafik: Nama Aturan Resmi',       'bar', 30, 31),
            makeChartDef('kelas',       'Grafik: Per Kelas',               'bar', 33, 34)
        ];
        if (schoolMode === 'smk') {
            chartDefinitions.push(makeChartDef('jurusan', 'Grafik: Per Jurusan', 'bar', 45, 46));
        }
        chartDefinitions.push(
            makeChartDef('tingkat', 'Grafik: Per Tingkat',     'pie',  36, 37),
            makeChartDef('minggu',  'Grafik: Tren Per Minggu', 'line', 39, 40),
            makeChartDef('bulan',   'Grafik: Tren Per Bulan',  'line', 42, 43)
        );

        const nativeChartConfigs = [];
        chartDefinitions.forEach(def => {
            const grouped = getExportChartGroups(filteredRecords, def.key);
            const labels = grouped.map(item => item[0]);
            const values = grouped.map(item => Number(item[1]) || 0);
            ws.getCell(1, def.catCol).value = 'Kategori';
            ws.getCell(1, def.valCol).value = 'Jumlah';
            labels.forEach((label, idx) => {
                ws.getCell(def.dataStart + idx, def.catCol).value = label;
                ws.getCell(def.dataStart + idx, def.valCol).value = values[idx];
            });
            ws.getColumn(def.catCol).hidden = true;
            ws.getColumn(def.valCol).hidden = true;
            if (labels.length) {
                nativeChartConfigs.push({
                    ...def,
                    labels,
                    values,
                    seriesLabel: 'Jumlah'
                });
            }
        });

        // Parallel fetch foto tabel utama (lebih cepat dari sequential)
        {
            const fotoUrls = [];
            const fotoRowNums = [];
            for (let r = 1; r <= ws.rowCount; r++) {
                const row = ws.getRow(r);
                if (row._exportFotoUrl) {
                    fotoUrls.push(row._exportFotoUrl);
                    fotoRowNums.push(row._exportRowNumber || r);
                }
            }
            if (fotoUrls.length) {
                const buffers = await fetchArrayBuffersParallel(fotoUrls, 5);
                buffers.forEach((arrayBuffer, i) => {
                    if (!arrayBuffer) return;
                    try {
                        const imageId = workbook.addImage({ buffer: arrayBuffer, extension: 'jpeg' });
                        ws.addImage(imageId, {
                            tl: { col: photoColIndex + 0.2, row: fotoRowNums[i] - 0.9 },
                            ext: { width: 60, height: 60 },
                            editAs: 'oneCell'
                        });
                    } catch (e) {
                        console.warn('Foto gagal dimasukkan:', e);
                    }
                });
            }
        }

        // ===== SHEET 2: Laporan Tindak Lanjut Pelanggaran =====
        // Sheet pertama (rekap + grafik native) sengaja tidak diubah.
        const officialRules = [
            {code:'R1', points:5, aliases:['datang terlambat','terlambat','telat']},
            {code:'R2', points:5, aliases:['atribut seragam tidak lengkap','tidak menggunakan atribut seragam','atribut seragam tidak sesuai','kacu','gesper','kaos kaki putih','kaos kaki']},
            {code:'R3', points:5, aliases:['seragam tidak sesuai jadwal','tidak menggunakan seragam sekolah','seragam tidak sesuai ketentuan']},
            {code:'R4', points:5, aliases:['sepatu tidak sesuai','tidak menggunakan sepatu sesuai','sepatu tidak sesuai ketentuan']},
            {code:'R5', points:5, aliases:['tidak membawa perlengkapan belajar','tidak membawa perlengkapan']},
            {code:'R6', points:5, aliases:['rambut tidak rapi','rambut tidak sesuai aturan']},
            {code:'R7', points:5, aliases:['membuang sampah sembarangan']},
            {code:'R8', points:5, aliases:['makan/minum di kelas','makan minum di kelas','makan di kelas saat pelajaran','minum di kelas saat pelajaran']},
            {code:'R9', points:10, aliases:['bermain hp saat pelajaran','main hp saat pelajaran','bermain handphone saat pelajaran','menggunakan hp saat pelajaran tanpa izin']},
            {code:'R10', points:10, aliases:['tidak mengikuti upacara','tidak ikut upacara']},
            {code:'S1', points:15, aliases:['membolos satu jam','bolos satu jam','membolos 1 jam','bolos 1 jam']},
            {code:'S2', points:15, aliases:['keluar kelas tanpa izin','keluar kelas tanpa seizin guru']},
            {code:'S3', points:20, aliases:['tidak masuk tanpa keterangan','alfa','alpha']},
            {code:'S4', points:20, aliases:['kecurangan pada saat ujian','tindak kecurangan saat ujian','kertas contekan','melihat jawaban teman','mengobrol ketika ujian','mencari jawaban melalui ai','menyontek saat ujian']},
            {code:'S5', points:20, aliases:['berbicara kasar','berkata kasar']},
            {code:'S6', points:20, aliases:['vandalisme','membuat kerusakan pada fasilitas sekolah','merusak fasilitas sekolah']},
            {code:'S7', points:25, aliases:['memalsukan tanda tangan']},
            {code:'S8', points:25, aliases:['menyebarkan konten tidak pantas','konten pornografi','konten berbau sara','konten perundungan','menyebarkan konten']},
            {code:'S9', points:25, aliases:['membolos selama satu hari penuh','bolos selama satu hari penuh','membolos satu hari penuh','bolos satu hari penuh','bolos seharian']},
            {code:'B1', points:30, aliases:['berkelahi dengan rekan sebaya','berkelahi di lingkungan sekolah']},
            {code:'B2', points:50, aliases:['membawa rokok','membawa vape','membawa rokok atau vape']},
            {code:'B3', points:50, aliases:['merokok','menggunakan vape','menghisap vape']},
            {code:'B4', points:50, aliases:['berkelahi hingga menyebabkan cedera','berkelahi hingga menyebabkan luka','berkelahi menyebabkan cedera','berkelahi menyebabkan luka']},
            {code:'B5', points:50, aliases:['bullying','perundungan','intimidasi']},
            {code:'B6', points:75, aliases:['membawa senjata tajam','senjata tajam']},
            {code:'B7', points:75, aliases:['merusak fasilitas sekolah secara sengaja','merusak fasilitas secara sengaja','merusak fasilitas sekolah dengan sengaja']},
            {code:'B8', points:75, aliases:['mencuri uang','mencuri barang milik teman','mencuri barang milik guru','mencuri barang milik warga']},
            {code:'B9', points:75, aliases:['mencuri fasilitas sekolah','mencuri barang fasilitas sekolah']},
            {code:'B10', points:100, aliases:['minuman keras','mengkonsumsi minuman keras','mengonsumsi minuman keras','membawa minuman keras']},
            {code:'B11', points:100, aliases:['narkotika','mengkonsumsi narkotika','mengonsumsi narkotika','membawa narkotika']},
            {code:'B12', points:100, aliases:['kekerasan seksual','pelecehan seksual']},
            {code:'B13', points:100, aliases:['berpotensi menimbulkan kriminalitas','tindak pidana kriminalitas','tindak pidana yang berpotensi kriminalitas']},
            {code:'B14', points:100, aliases:['perjudian','berjudi']},
            {code:'B15', points:100, aliases:['tawuran','konvoi berpotensi tawuran','berkumpul berpotensi tawuran']}
        ];
        const normalizeViolation = value => String(value || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

        function mapOfficialViolation(description){
            const original = String(description || '').trim();
            if(!original) return {codes:[], points:0, unmapped:true, unmappedParts:['(deskripsi kosong)']};
            const text = normalizeViolation(original);
            // Klasifikasi dilakukan terhadap seluruh deskripsi agar contoh-contoh yang dipisahkan
            // koma dalam aturan resmi (mis. contekan/melihat jawaban) tidak dihitung sebagai
            // beberapa pelanggaran. Pemisahan hanya dipakai untuk menandai potongan yang tak dikenal.
            let matches = officialRules.filter(rule =>
                rule.aliases.some(alias => text.includes(normalizeViolation(alias)))
            );
            // Tambahkan aturan aktif dari database: pelanggaran baru yang sudah memiliki
            // aturan resmi di Supabase dikenali saat export tanpa verifikasi manual.
            exportOfficialRulesFromDb.filter(dbRule => dbRule.active === true).forEach(dbRule => {
                const ruleName = normalizeViolation(dbRule.name);
                if (ruleName.length >= 8 && (text.includes(ruleName) || ruleName.includes(text))) {
                    const code = String(dbRule.code || '').trim().toUpperCase();
                    if (code && !matches.some(rule => rule.code === code)) {
                        matches.push({code, points:Number(dbRule.points)||0, aliases:[dbRule.name], severity:dbRule.severity});
                    }
                }
            });
            // Kasus khusus untuk membedakan pelanggaran sedang/berat yang memakai kata serupa.
            if(/konten/.test(text) && /perundungan|bullying/.test(text)) matches = matches.filter(r=>r.code !== 'B5');
            if(/merusak fasilitas/.test(text) && /sengaja|dengan sengaja/.test(text)) matches = matches.filter(r=>r.code !== 'S6');
            if(/berkelahi/.test(text) && /cedera|luka/.test(text)) matches = matches.filter(r=>r.code !== 'B1');
            if(/mencuri/.test(text) && /fasilitas sekolah/.test(text)) matches = matches.filter(r=>r.code !== 'B8');
            if(/membawa/.test(text) && /rokok|vape/.test(text) && !/merokok|menggunakan vape|menghisap vape/.test(text)) matches = matches.filter(r=>r.code !== 'B3');

            const parts = original.split(/[;+\n]+|,(?=\s*)/).map(v=>v.trim()).filter(Boolean);
            const offenseVerbPattern = /\b(terlambat|telat|menggunakan|tidak|membawa|bermain|keluar|makan|minum|melakukan|menyebarkan|berbicara|berkata|merokok|mencuri|berkelahi|merusak|memalsukan|membolos|absensi|alfa|alpha|bolos|memakai|mengonsumsi|mengkonsumsi|menghisap|berjudi|konvoi|berkumpul|rambut|vandalisme|makeup|make up|lipstik|eyelash|blush on|alis)\b/;
            const unmappedParts = parts.filter(part=>{
                const partText = normalizeViolation(part);
                const hasKnownRule = officialRules.some(rule=>rule.aliases.some(alias=>partText.includes(normalizeViolation(alias))))
                    || exportOfficialRulesFromDb.filter(rule=>rule.active === true).some(rule=>{
                        const ruleName = normalizeViolation(rule.name);
                        return ruleName.length >= 8 && (partText.includes(ruleName) || ruleName.includes(partText));
                    });
                // Abaikan fragmen benda/contoh yang dipisahkan koma (mis. "barang-barang"),
                // tetapi tandai klausa yang tampak seperti jenis pelanggaran lain namun tak dikenal.
                return !hasKnownRule && offenseVerbPattern.test(partText);
            });
            if(!matches.length && !unmappedParts.length) unmappedParts.push(original);
            // Jika catatan menyebut jumlah kejadian (mis. terlambat 4 hari / 14 alfa),
            // kalikan poin per kejadian. Angka seperti '10 menit' tidak dihitung sebagai frekuensi.
            const countMatch = text.match(/\b(\d+)\s*(?:x|kali|hari|alfa|alpha)\b/);
            const multiplier = countMatch ? Math.max(1, Math.min(1000, Number(countMatch[1]) || 1)) : 1;
            const codes = [];
            let points = 0;
            matches.forEach(rule=>{
                for(let occurrence=0; occurrence<multiplier; occurrence++) codes.push(rule.code);
                points += rule.points * multiplier;
            });
            return {codes, points, unmapped:unmappedParts.length>0, unmappedParts};
        }

        const followGroupsMap = new Map();
        // Riwayat Sheet Tindak Lanjut harus menampilkan SEMUA catatan siswa
        // pada Tahun Ajaran yang sama, bukan hanya catatan yang lolos filter
        // periode export (mis. bulan/semester/rentang tanggal). Ini mencegah
        // total 3x+ tetapi rincian di Excel hanya tampil 1–2 baris.
        filterBySchoolMode(records).forEach(item => {
            const nama = String(item.nama || '').trim();
            if(!nama) return;
            const ta = String(item.tahun_ajaran || '').trim();
            if(!ta) return;
            const groupKey = `${normalizeName(nama)}__${normTA(ta)}`;
            if(!followGroupsMap.has(groupKey)){
                followGroupsMap.set(groupKey, {
                    nama,
                    kelas: String(item.kelas || '').trim() || '-',
                    kelasList: [],
                    records: [],
                    tahun_ajaran: ta
                });
            }
            const group = followGroupsMap.get(groupKey);
            group.records.push(item);
            const kelas = String(item.kelas || '').trim();
            if(kelas && !group.kelasList.some(k=>normalizeName(k)===normalizeName(kelas))) group.kelasList.push(kelas);
        });
        // Kelayakan Sheet Tindak Lanjut: minimal 3 catatan dalam satu Tahun Ajaran ATAU
        // setidaknya satu pelanggaran kategori Berat berdasarkan snapshot poin database.
        // Kedua kriteria digabung dalam satu sheet dan tidak dipisah.
        // Isi riwayat juga menggunakan seluruh catatan dalam TA yang sama.
        const eligibleThreeStrikeKeys = new Set();
        const allRecordsByStudentTA = new Map();
        filterBySchoolMode(records).forEach(item => {
            const nama = String(item.nama || '').trim();
            if(!nama) return;
            // Catatan tanpa Tahun Ajaran valid tidak digabungkan ke tahun ajaran lain.
            const ta = String(item.tahun_ajaran || '').trim();
            if(!ta) return;
            const key = `${normalizeName(nama)}__${normTA(ta)}`;
            const current = allRecordsByStudentTA.get(key) || {count:0, heavy:false};
            current.count += 1;
            if(hasHeavyPointRecord(item)) current.heavy = true;
            allRecordsByStudentTA.set(key, current);
        });
        allRecordsByStudentTA.forEach((summary,key)=>{
            // Satu daftar tindak lanjut: minimal 3 catatan ATAU minimal satu poin kategori Berat.
            if(summary.count >= 3 || summary.heavy) eligibleThreeStrikeKeys.add(key);
        });

        const followGroups = [...followGroupsMap.values()].map(g=>{
            const latest = [...g.records].sort((a,b)=>
                String(b.tanggal||'').localeCompare(String(a.tanggal||'')) || Number(b.id||0)-Number(a.id||0)
            )[0];
            g.kelas = String(latest?.kelas || g.kelas || '-').trim() || '-';
            return g;
        }).filter(g => eligibleThreeStrikeKeys.has(`${normalizeName(g.nama)}__${normTA(g.tahun_ajaran)}`))
          .sort((a,b)=>a.nama.localeCompare(b.nama,'id'));

        const ws2 = workbook.addWorksheet('Tindak Lanjut');
        ws2.mergeCells('A1:J1');
        ws2.mergeCells('A2:J2');
        ws2.getCell('A1').value = 'TINDAK LANJUT PELANGGARAN PESERTA DIDIK';
        ws2.getCell('A2').value = `${getSchoolModeLabel().toUpperCase()} GELORA BEKASI — ${periodeLabel}`;
        ['A1','A2'].forEach((cell,i)=>{
            ws2.getCell(cell).font = {name:'Arial', size:i===0?14:11, bold:true, color:{argb:i===0?'0F172A':'334155'}};
            ws2.getCell(cell).alignment = {horizontal:'center', vertical:'middle'};
        });
        ws2.getRow(1).height = 25;
        ws2.getRow(2).height = 21;
        ws2.getRow(3).height = 8;
        const followHeader = ws2.addRow([
            'NO.','NAMA SISWA','KELAS','PELANGGARAN','KODE','POIN',
            'WALI MURID','WAKTU PEMANGGILAN','TINDAK LANJUT','FOTO DOKUMENTASI'
        ]);
        followHeader.height = 32;
        followHeader.eachCell(cell=>{
            cell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'C2410C'}};
            cell.font = {name:'Arial', bold:true, color:{argb:'FFFFFF'}, size:10};
            cell.alignment = {horizontal:'center', vertical:'middle', wrapText:true};
            cell.border = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};
        });
        [6,27,13,42,18,13,23,19,42,24].forEach((w,i)=>ws2.getColumn(i+1).width=w);
        ws2.views = [{state:'frozen', xSplit:0, ySplit:4, topLeftCell:'A5', activeCell:'A5'}];
        ws2.autoFilter = {from:'A4', to:'J4'};
        ws2.pageSetup = {orientation:'landscape', fitToPage:true, fitToWidth:1, fitToHeight:0, paperSize:9, margins:{left:0.25,right:0.25,top:0.5,bottom:0.5,header:0.2,footer:0.2}};
        ws2.headerFooter = {oddFooter:'&CHalaman &P dari &N'};

        const evidenceJobs = [];
        followGroups.forEach((g,idx)=>{
            const {follow} = getThreeStrikeFollowUp(g);
            const sorted = [...g.records].sort((a,b)=>
                String(a.tanggal||'').localeCompare(String(b.tanggal||'')) || Number(a.id||0)-Number(b.id||0)
            );
            const perRecord = sorted.map(r=>{
                const inferred = mapOfficialViolation(r.pelanggaran);
                // Jika mapping database tersedia, gunakan kode dan snapshot poin yang benar-benar tersimpan.
                // Klasifikasi teks tetap dipakai untuk mendeteksi komponen lain yang belum punya aturan.
                let storedItems = [];
                try {
                    if (typeof getRecordPointItems === 'function') storedItems = getRecordPointItems(r.id) || [];
                } catch (_) {}
                if (Array.isArray(storedItems) && storedItems.length) {
                    const storedCodes = storedItems.map(item=>String(item.violation_code || '').trim()).filter(Boolean);
                    const storedPoints = storedItems.reduce((sum,item)=>sum + (Number(item.points_snapshot) || 0), 0);
                    return {
                        record:r,
                        mapped:{...inferred, codes:storedCodes, points:storedPoints, unmapped:false, unmappedParts:[]}
                    };
                }
                return {record:r, mapped:inferred};
            });
            const codeCounts = new Map();
            let totalPoints = 0;
            let hasUnmapped = false;
            const violationLines = [];
            perRecord.forEach(({record,mapped})=>{
                violationLines.push(`${formatTanggalIndonesia(record.tanggal)||'-'} — ${record.pelanggaran||'-'}`);
                mapped.codes.forEach(code=>codeCounts.set(code,(codeCounts.get(code)||0)+1));
                totalPoints += mapped.points;
                if(mapped.unmapped){
                    hasUnmapped = true;
                    mapped.unmappedParts.forEach(part=>violationLines.push(`⚠ Perlu verifikasi jenis/poin: ${part}`));
                }
            });
            const codeText = [...codeCounts.entries()].map(([code,count])=>`${code}${count>1?` (${count}x)`:''}`).join(', ');
            const followStatus = follow.status || 'Belum Ditindak';
            const followText = followStatus === 'Belum Ditindak'
                ? 'Belum ditindaklanjuti'
                : `${followStatus}${follow.catatan ? '\n'+follow.catatan : ''}`;
            const buktiUrls = parseBuktiUrls(follow.bukti_urls);
            const wali = sorted.map(r=>r.wali_murid||r.nama_wali||r.orang_tua||r.wali||'').find(v=>String(v).trim()) || '-';
            const row = ws2.addRow([
                idx+1,
                g.nama || '-',
                g.kelas || '-',
                violationLines.join('\n') || '-',
                codeText || 'Perlu verifikasi',
                hasUnmapped ? 'Perlu verifikasi' : totalPoints,
                wali,
                follow.tanggal ? formatTanggalIndonesia(follow.tanggal) : '-',
                followText,
                buktiUrls.length ? '' : '-'
            ]);
            // Tinggi baris disesuaikan dengan isi riwayat dan jumlah foto agar setiap foto tetap berada di dalam batas cell.
            const textHeight = Math.min(210, Math.max(1, violationLines.length) * 19);
            const evidenceHeight = buktiUrls.length ? (buktiUrls.length * 82 + 8) : 0;
            row.height = Math.max(66, textHeight, evidenceHeight);
            row.eachCell({includeEmpty:true},cell=>{
                cell.font = {name:'Arial', size:10, color:{argb:'1E293B'}};
                cell.alignment = {vertical:'top', horizontal:'left', wrapText:true};
                cell.border = {top:{style:'thin',color:{argb:'CBD5E1'}},left:{style:'thin',color:{argb:'CBD5E1'}},bottom:{style:'thin',color:{argb:'CBD5E1'}},right:{style:'thin',color:{argb:'CBD5E1'}}};
                if(idx%2===1) cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'F8FAFC'}};
            });
            [1,3,5,6,8].forEach(c=>row.getCell(c).alignment={vertical:'middle',horizontal:'center',wrapText:true});
            // Nama siswa rata kiri dan rata tengah secara vertikal agar konsisten dengan isi baris.
            row.getCell(2).alignment = {vertical:'middle', horizontal:'left', wrapText:true, indent:1};
            // Dokumentasi kosong cukup ditandai strip; jangan biarkan teks memperlebar/menambah tinggi baris.
            row.getCell(10).alignment = {vertical:'middle', horizontal:'center', wrapText:false};
            row.getCell(4).alignment = {vertical:'top',horizontal:'left',wrapText:true};
            row.getCell(9).alignment = {vertical:'top',horizontal:'left',wrapText:true};
            if(hasUnmapped){
                row.getCell(5).font = {name:'Arial',size:10,bold:true,color:{argb:'B45309'}};
                row.getCell(6).font = {name:'Arial',size:10,bold:true,color:{argb:'B45309'}};
                row.getCell(6).note = 'Ada deskripsi pelanggaran yang belum dapat dipetakan secara pasti ke kode resmi R/S/B pada PDF. Verifikasi sebelum poin dijadikan keputusan administratif.';
            }
            if(followStatus==='Belum Ditindak') row.getCell(9).font={name:'Arial',size:10,bold:true,color:{argb:'DC2626'}};
            else row.getCell(9).font={name:'Arial',size:10,bold:true,color:{argb:'166534'}};
            row._evidenceUrls = buktiUrls;
            row._evidenceRowNumber = row.number;
            if(buktiUrls.length){
                evidenceJobs.push({rowNum:row.number, urls:buktiUrls});
            }
        });

        if(!followGroups.length){
            const emptyRow = ws2.addRow(['','Tidak ada data tindak lanjut untuk periode yang dipilih.','','','','','','','','']);
            ws2.mergeCells(`B${emptyRow.number}:J${emptyRow.number}`);
            emptyRow.height = 28;
            emptyRow.getCell(2).font = {name:'Arial',italic:true,color:{argb:'64748B'}};
        }

        // Sisipkan foto/dokumen tindak lanjut yang diunggah lewat aplikasi ke kolom Dokumentasi.
        if(evidenceJobs.length){
            const imageTasks = [];
            evidenceJobs.forEach(job=>job.urls.forEach((url,index)=>imageTasks.push({url,rowNum:job.rowNum,index,count:job.urls.length}))); 
            const imageBuffers = await fetchArrayBuffersParallel(imageTasks.map(x=>x.url),5);
            imageBuffers.forEach((arrayBuffer,i)=>{
                if(!arrayBuffer) return;
                const task = imageTasks[i];
                try{
                    const imageId = workbook.addImage({buffer:arrayBuffer,extension:'jpeg'});
                    ws2.addImage(imageId,{
                        // Foto dipusatkan di kolom J; lebar/tinggi disesuaikan dengan sel dokumentasi.
                        tl:{col:9.12,row:task.rowNum-1 + 0.28 + (task.index * (82 / 15))},
                        ext:{width:148,height:74},
                        editAs:'oneCell'
                    });
                }catch(err){ console.warn('Bukti tindak lanjut gagal dimasukkan ke Excel:',err); }
            });
        }

        let buffer = await workbook.xlsx.writeBuffer();
        // Chart native hanya untuk sheet pertama (Rekap Pelanggaran)
        buffer = await addNativeExcelCharts(buffer, nativeChartConfigs);
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `Rekap_Pelanggaran_${getSchoolModeLabel().replace(/\s+/g, '_')}_${fileTA}_${fileSem}.xlsx`;
        link.click();
        URL.revokeObjectURL(url);

        const nFollow = followGroups.length;
        Swal.fire({
            icon: 'success',
            title: 'Berhasil Export',
            text: `File Excel berhasil diunduh: Sheet 1 rekap bergrafik tetap dipertahankan, Sheet 2 berisi ${nFollow} siswa dengan 3x+ pelanggaran atau minimal satu pelanggaran kategori Berat, beserta seluruh riwayat pelanggaran dalam Tahun Ajaran yang sama.`,
            confirmButtonColor: '#21a366'
        });
    }catch(err){
        console.error(err);
        Swal.fire({
            icon: 'error',
            title: 'Export Gagal',
            text: 'Terjadi kesalahan saat export: '+err.message,
            confirmButtonColor: '#e53935'
        });
    }
}

// API publik modul
global.__smpgeloraExport = {
    exportToExcel: typeof exportToExcel === 'function' ? exportToExcel : null,
    exportThreeStrikeReport: typeof exportThreeStrikeReport === 'function' ? exportThreeStrikeReport : null
};
})(window);
