/**
 * SMP-SMK Gelora — modul Export Excel (lazy-loaded)
 * Dipanggil hanya saat user menekan Export.
 * Bergantung pada: records, filterBySchoolMode, getGroups, escapeHtml, dll. di smpgelora.js
 */
(function (global) {
'use strict';

/* EXPORT KHUSUS SISWA YANG SUDAH 3X+ PELANGGARAN */
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
    const students = getThreeStrikeStudents();

    if(!students.length){
        return Swal.fire({
            icon:'info',
            title:'Report Kosong',
            text:'Belum ada siswa yang mencapai 3x pelanggaran.',
            confirmButtonColor:'#f97316'
        });
    }

    Swal.fire({
        title:'Mengeksport Report 3x...',
        html:'Menyiapkan seluruh siswa 3x+ pelanggaran.',
        allowOutsideClick:false,
        didOpen:()=>Swal.showLoading()
    });

    try{
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Report 3x');

        const { tahunAjaran: defaultTA3 } = getDefaultTahunAjaranSemester();
        const taLabel3 = (typeof getAvailableTahunAjaranList === 'function' && getAvailableTahunAjaranList().length)
            ? getAvailableTahunAjaranList()[0]
            : defaultTA3;

        ws.mergeCells('A1:J1');
        ws.mergeCells('A2:J2');
        ws.mergeCells('A3:J3');
        ws.getCell('A1').value = 'REPORT SISWA 3X PELANGGARAN (' + getSchoolModeLabel() + ')';
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
            text:`${students.length} siswa dengan 3x atau lebih pelanggaran berhasil dimasukkan ke Excel.`,
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

                <p style="font-size:11px; color:#64748b; margin:8px 0 0;">Sheet Report 3x mengikuti filter yang sama. Bukti tindakan ikut diexport jika ada.</p>
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
            makeChartDef('jenis',   'Grafik: Jenis Pelanggaran', 'bar',  27, 28),
            makeChartDef('kelas',   'Grafik: Per Kelas',         'bar',  30, 31)
        ];
        if (schoolMode === 'smk') {
            chartDefinitions.push(makeChartDef('jurusan', 'Grafik: Per Jurusan', 'bar', 42, 43));
        }
        chartDefinitions.push(
            makeChartDef('tingkat', 'Grafik: Per Tingkat',     'pie',  33, 34),
            makeChartDef('minggu',  'Grafik: Tren Per Minggu', 'line', 36, 37),
            makeChartDef('bulan',   'Grafik: Tren Per Bulan',  'line', 39, 40)
        );

        const nativeChartConfigs = [];
        chartDefinitions.forEach(def => {
            const grouped = getGroups(filteredRecords, def.key);
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

        // ===== SHEET 2: Report 3x Pelanggaran + status tindak lanjut + foto + bukti tindakan =====
        const threeStrikeGroups = {};
        filteredRecords.forEach(item => {
            const nama = String(item.nama || '').trim();
            if (!nama) return;
            const key = normalizeName(nama);
            if (!threeStrikeGroups[key]) {
                threeStrikeGroups[key] = {
                    nama,
                    kelas: String(item.kelas || '').trim() || '-',
                    kelasList: [],
                    records: [],
                    tahun_ajaran: item.tahun_ajaran || ''
                };
            }
            threeStrikeGroups[key].records.push(item);
            const kelas = String(item.kelas || '').trim();
            if (kelas && !threeStrikeGroups[key].kelasList.some(k => normalizeName(k) === normalizeName(kelas))) {
                threeStrikeGroups[key].kelasList.push(kelas);
            }
            if (!threeStrikeGroups[key].tahun_ajaran && item.tahun_ajaran) {
                threeStrikeGroups[key].tahun_ajaran = item.tahun_ajaran;
            }
        });

        const threeStrikeStudents = Object.values(threeStrikeGroups)
            .map(g => {
                const latest = [...g.records].sort((a, b) =>
                    String(b.tanggal || '').localeCompare(String(a.tanggal || '')) ||
                    Number(b.id || 0) - Number(a.id || 0)
                )[0];
                g.kelas = String(latest?.kelas || g.kelas || '-').trim() || '-';
                g.tahun_ajaran = g.tahun_ajaran || latest?.tahun_ajaran || '';
                return g;
            })
            .filter(g => g.records.length >= 3)
            .sort((a, b) =>
                b.records.length - a.records.length ||
                a.nama.localeCompare(b.nama, 'id')
            );

        const ws3 = workbook.addWorksheet('Report 3x Pelanggaran');
        ws3.mergeCells('A1:K1');
        ws3.mergeCells('A2:K2');
        ws3.mergeCells('A3:K3');
        ws3.getCell('A1').value = 'REPORT 3X PELANGGARAN — SISWA 3X ATAU LEBIH (' + getSchoolModeLabel() + ')';
        ws3.getCell('A2').value = 'SMP - SMK GELORA BEKASI';
        ws3.getCell('A3').value = periodeLabel;
        ['A1', 'A2', 'A3'].forEach((cell, i) => {
            ws3.getCell(cell).font = {
                name: 'Arial',
                size: i === 0 ? 14 : 11,
                bold: true,
                color: { argb: i === 0 ? '0F172A' : '334155' }
            };
            ws3.getCell(cell).alignment = { horizontal: 'center', vertical: 'middle' };
        });
        ws3.getRow(1).height = 22;
        ws3.getRow(2).height = 18;
        ws3.getRow(3).height = 16;

        // Header langsung baris 4 (tanpa baris kosong)
        const header3 = ws3.addRow([
            'No', 'Foto Bukti Terbaru', 'Nama Siswa', 'Kelas', 'Total Pelanggaran',
            'Status Tindak Lanjut', 'Tanggal Tindakan', 'Ditindak Oleh', 'Catatan',
            'Bukti Tindakan', 'Riwayat Pelanggaran'
        ]);
        header3.height = 22;
        header3.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'C2410C' } };
            cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFF' }, size: 10 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = {
                top: { style: 'thin' }, left: { style: 'thin' },
                bottom: { style: 'thin' }, right: { style: 'thin' }
            };
        });
        [6, 14, 26, 12, 14, 22, 14, 18, 26, 18, 48].forEach((w, i) => ws3.getColumn(i + 1).width = w);
        ws3.views = [{ state: 'frozen', xSplit: 0, ySplit: 4, topLeftCell: 'A5', activeCell: 'A5' }];

        if (!threeStrikeStudents.length) {
            const emptyRow = ws3.addRow(['', '', 'Tidak ada siswa dengan 3x atau lebih pelanggaran pada periode ini.', '', '', '', '', '', '', '', '']);
            ws3.mergeCells(`C${emptyRow.number}:K${emptyRow.number}`);
            emptyRow.getCell(3).font = { italic: true, color: { argb: '64748B' } };
        } else {
            for (let idx = 0; idx < threeStrikeStudents.length; idx++) {
                const g = threeStrikeStudents[idx];
                const { follow } = getThreeStrikeFollowUp(g);
                const sorted = [...g.records].sort((a, b) =>
                    String(a.tanggal || '').localeCompare(String(b.tanggal || '')) ||
                    Number(a.id || 0) - Number(b.id || 0)
                );
                const riwayat = sorted
                    .map((r, n) => `${n + 1}. ${r.pelanggaran || '-'} — ${formatTanggalIndonesia(r.tanggal) || '-'}`)
                    .join('\n');

                const latestWithPhoto = [...sorted].reverse().find(r => r.foto_url) || null;
                const status = follow.status || 'Belum Ditindak';
                const buktiUrls = parseBuktiUrls(follow.bukti_urls);

                const row = ws3.addRow([
                    idx + 1, '',
                    g.nama || '-', g.kelas || '-', g.records.length, status,
                    follow.tanggal ? formatTanggalIndonesia(follow.tanggal) : '-',
                    follow.oleh || '-', follow.catatan || '-',
                    buktiUrls.length ? `${buktiUrls.length} bukti` : 'Tidak ada bukti',
                    riwayat || '-'
                ]);
                row.height = Math.max(70, Math.min(220, 16 * Math.max(3, riwayat.split('\n').length)));
                row.eachCell({ includeEmpty: true }, cell => {
                    cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
                    cell.border = {
                        top: { style: 'thin' }, left: { style: 'thin' },
                        bottom: { style: 'thin' }, right: { style: 'thin' }
                    };
                });
                [1, 4, 5].forEach(c => {
                    row.getCell(c).alignment = { vertical: 'top', horizontal: 'center', wrapText: true };
                });

                const statusCell = row.getCell(6);
                if (status === 'Belum Ditindak') statusCell.font = { bold: true, color: { argb: 'DC2626' } };
                else if (status.includes('Selesai')) statusCell.font = { bold: true, color: { argb: '16A34A' } };
                else statusCell.font = { bold: true, color: { argb: 'D97706' } };

                row._exportLatestFoto = latestWithPhoto?.foto_url || null;
                row._exportBuktiUrls = buktiUrls.slice(0, 4);
                row._exportRowNumber = row.number;
                if (!latestWithPhoto?.foto_url) {
                    row.getCell(2).value = 'Tidak ada foto';
                }
            }

            // Parallel fetch foto + bukti sheet 3x
            const jobs = [];
            for (let r = 1; r <= ws3.rowCount; r++) {
                const row = ws3.getRow(r);
                if (row._exportLatestFoto) {
                    jobs.push({ type: 'foto', url: row._exportLatestFoto, rowNum: row._exportRowNumber || r, row });
                }
                (row._exportBuktiUrls || []).forEach(url => {
                    jobs.push({ type: 'bukti', url, rowNum: row._exportRowNumber || r, row });
                });
            }
            if (jobs.length) {
                const buffers = await fetchArrayBuffersParallel(jobs.map(j => j.url), 5);
                buffers.forEach((arrayBuffer, i) => {
                    const job = jobs[i];
                    if (!arrayBuffer) {
                        if (job.type === 'foto') {
                            try { job.row.getCell(2).value = 'Foto gagal dimuat'; } catch (_) {}
                        }
                        return;
                    }
                    try {
                        const imageId = workbook.addImage({ buffer: arrayBuffer, extension: 'jpeg' });
                        if (job.type === 'foto') {
                            ws3.addImage(imageId, {
                                tl: { col: 1.15, row: job.rowNum - 0.85 },
                                ext: { width: 95, height: 75 },
                                editAs: 'oneCell'
                            });
                        } else {
                            ws3.addImage(imageId, {
                                tl: { col: 9.1, row: job.rowNum - 0.85 },
                                ext: { width: 70, height: 55 },
                                editAs: 'oneCell'
                            });
                        }
                    } catch (e) {
                        console.warn('Gambar 3x gagal dimasukkan:', e);
                    }
                });
            }
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

        const n3 = threeStrikeStudents.length;
        Swal.fire({
            icon: 'success',
            title: 'Berhasil Export',
            text: n3
                ? `File rekap berhasil diunduh (termasuk ${n3} siswa 3x+ di sheet kedua).`
                : 'File rekap Excel berhasil diunduh.',
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
