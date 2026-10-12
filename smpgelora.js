const SUPABASE_URL = "https://pdhraphbbdjsabhiokgo.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkaHJhcGhiYmRqc2FiaGlva2dvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyODMxODUsImV4cCI6MjEwNDg1OTE4NX0.FesFprS6pIbuz1x2YDOw1rKdvjgirWRBt3sPrR5EhpY";
const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;
let authReady = false;
// Authorization is provided by Supabase Auth. Legacy localStorage sessions are invalidated.
try { localStorage.removeItem('user_session'); } catch (_) {}
let records = [];
let usersList = [];
let violationCategories = [];
let violationPointRules = [];
let violationPointRulesAll = [];
let violationPointRulesAllLoaded = false;
let violationPointRulesLoaded = false;
let violationPointRulesIncludeInactive = false;
let violationPointRulesError = null;
let violationPointItemsByRecord = {};
let violationPointItemsLoaded = false;
let violationPointItemsError = null;
let editPointItemsOriginal = [];
let editPointCodesOriginal = [];
let myChart = null;
// Jangan pernah render data tindak lanjut dari localStorage lama.
// Data tindak lanjut hanya boleh berasal dari tabel Supabase.
let followUpMap = {};
let followUpCloudReady = false;
let followUpSyncLastError = '';
let appDataLoaded = false;
let dashboardPeriod = 'all'; // all | today | week | month | semester
let dashTrendChart = null;

const STORAGE_BUCKET = 'foto-pelanggaran';
const STORAGE_SIGNED_URL_TTL = 60 * 60;

function storagePathFromValue(value){
    if(!value || typeof value !== 'string') return null;
    const raw = value.trim();
    if(!raw) return null;
    if(!/^https?:\/\//i.test(raw)) return raw.replace(/^\/+/, '');
    try{
        const url = new URL(raw);
        const publicMarker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
        const signMarker = `/storage/v1/object/sign/${STORAGE_BUCKET}/`;
        let path = null;
        if(url.pathname.includes(publicMarker)) path = url.pathname.split(publicMarker)[1];
        else if(url.pathname.includes(signMarker)) path = url.pathname.split(signMarker)[1];
        if(!path) return null;
        return decodeURIComponent(path).replace(/^\/+/, '');
    }catch(e){ return null; }
}

async function createSignedStorageUrl(value){
    const path = storagePathFromValue(value);
    if(!path) return null;
    const {data, error} = await _supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(path, STORAGE_SIGNED_URL_TTL);
    if(error) throw error;
    return data?.signedUrl || null;
}

async function resolveStorageUrlList(values){
    const arr = parseBuktiUrls(values);
    if(!arr.length) return [];
    const out = [];
    for(const value of arr){
        try{
            const signed = await createSignedStorageUrl(value);
            if(signed) out.push(signed);
        }catch(err){
            console.warn('Gagal membuat signed URL storage:', err.message || err);
        }
    }
    return out;
}

function storagePathsFromValues(values){
    return parseBuktiUrls(values)
        .map(storagePathFromValue)
        .filter(Boolean);
}

async function resolvePelanggaranStorageUrls(rows){
    const list = Array.isArray(rows) ? rows : [];
    await Promise.all(list.map(async row => {
        if(!row?.foto_url) return;
        try{
            const signed = await createSignedStorageUrl(row.foto_url);
            if(signed) row.foto_url = signed;
        }catch(err){
            console.warn('Gagal membuat signed URL foto:', err.message || err);
        }
    }));
    return list;
}


function showAppLoading(message = 'Sedang memuat data...'){
    const loader = document.getElementById('app-loading');
    const text = loader ? loader.querySelector('.app-loading-text') : null;
    if(text) text.textContent = message;
    if(loader){
        loader.classList.remove('hidden');
        loader.setAttribute('aria-busy','true');
    }
}

function hideAppLoading(){
    const loader = document.getElementById('app-loading');
    if(!loader) return;
    loader.setAttribute('aria-busy','false');
    loader.classList.add('hidden');
    window.setTimeout(() => {
        if(loader.classList.contains('hidden')) loader.style.display = 'none';
    }, 260);
}

// Variabel Pagination
let currentPage = 1;
const rowsPerPage = 10;
let filteredRecordsCache = [];

// Mode jenjang: all | smp | smk (disimpan di localStorage)
let schoolMode = 'all';
try {
    const savedMode = localStorage.getItem('smpgelora_school_mode');
    if (savedMode === 'all' || savedMode === 'smp' || savedMode === 'smk') schoolMode = savedMode;
} catch (e) {}

function isSMKRecord(item) {
    return !!(item && String(item.jurusan || '').trim());
}
function isSMPRecord(item) {
    return !isSMKRecord(item);
}
function filterBySchoolMode(list) {
    const arr = Array.isArray(list) ? list : [];
    if (schoolMode === 'smp') return arr.filter(isSMPRecord);
    if (schoolMode === 'smk') return arr.filter(isSMKRecord);
    return arr;
}
function getSchoolModeLabel() {
    if (schoolMode === 'smp') return 'SMP';
    if (schoolMode === 'smk') return 'SMK';
    return 'SMP - SMK';
}
function setSchoolMode(mode) {
    if (mode !== 'all' && mode !== 'smp' && mode !== 'smk') mode = 'all';

    // Admin SMP/SMK tidak boleh ganti toggle — mode terkunci ke jenjang akun
    if (!canUseSchoolToggle()) {
        const locked = normalizeJenjang(currentUser.jenjang);
        mode = locked;
    }

    schoolMode = mode;
    try { localStorage.setItem('smpgelora_school_mode', mode); } catch (e) {}

    document.querySelectorAll('.school-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Sinkron UI khusus SMP vs SMK (form, tabel, grafik, placeholder)
    syncSchoolModeUI();
    syncToggleVisibility();

    // Refresh semua tampilan yang terpengaruh
    refreshViews({ stats: true, recent: true, data: true });
    // Super Admin: form mengikuti toggle; admin SMP/SMK: form tetap terkunci role
    if (document.getElementById('page-form')?.classList.contains('active')) {
        syncFormSchoolUI();
    }
    if (document.getElementById('page-chart')?.classList.contains('active')) {
        updateChart(records);
    }
    if (document.getElementById('page-report')?.classList.contains('active')) {
        renderThreeStrikeReport();
    }
}

/** Tampilkan opsi "Per Jurusan" hanya saat mode SMK */
function syncChartJurusanOption() {
    const filterEl = document.getElementById('chart-filter');
    if (!filterEl) return;
    const jurusanOpt = filterEl.querySelector('option[value="jurusan"]');
    if (!jurusanOpt) return;

    if (schoolMode === 'smk') {
        jurusanOpt.hidden = false;
        jurusanOpt.disabled = false;
    } else {
        // SMP / Semua → sembunyikan
        jurusanOpt.hidden = true;
        jurusanOpt.disabled = true;
        if (filterEl.value === 'jurusan') {
            filterEl.value = 'jenis';
        }
    }
}

/**
 * Sinkronkan UI berdasarkan schoolMode:
 * - SMP  → sembunyikan form/kolom jurusan
 * - SMK  → tampilkan form/kolom jurusan (wajib)
 * - Semua → tampilkan jurusan (opsional)
 */
function syncSchoolModeUI() {
    syncChartJurusanOption();

    const showJurusan = schoolMode !== 'smp';
    const formGroupJurusan = document.getElementById('form-group-jurusan');
    const elJurusan = document.getElementById('jurusan');
    const thJurusan = document.getElementById('th-jurusan');
    const elKelas = document.getElementById('kelas');
    const searchInput = document.getElementById('search-input');
    const reportSearch = document.getElementById('report-search');
    const jurusanNote = document.getElementById('jurusan-note');

    if (formGroupJurusan) {
        formGroupJurusan.style.display = showJurusan ? '' : 'none';
    }
    if (thJurusan) {
        thJurusan.style.display = showJurusan ? '' : 'none';
    }
    // Mode SMP: kosongkan input jurusan agar tidak ikut tersimpan
    if (!showJurusan && elJurusan) {
        elJurusan.value = '';
    }

    if (elKelas) {
        if (schoolMode === 'smp') {
            elKelas.placeholder = 'Contoh: 7A / 8B / 9C';
        } else if (schoolMode === 'smk') {
            elKelas.placeholder = 'Contoh: X TKJ 1 / XI RPL 2';
        } else {
            elKelas.placeholder = 'Contoh: 8A / XI TKJ 1';
        }
    }

    if (jurusanNote) {
        jurusanNote.textContent = schoolMode === 'smk' ? '(wajib untuk SMK)' : '(opsional)';
    }

    if (searchInput) {
        searchInput.placeholder = showJurusan
            ? 'Cari nama, kelas, jurusan, semester...'
            : 'Cari nama, kelas, semester...';
    }
    if (reportSearch) {
        reportSearch.placeholder = showJurusan
            ? 'Cari nama, kelas, jurusan, semester...'
            : 'Cari nama, kelas, semester...';
    }
}


/** Normalisasi nilai jenjang user */
function normalizeJenjang(value) {
    const v = String(value || '').toLowerCase().trim();
    if (v === 'smp' || v === 'smk' || v === 'all') return v;
    return 'all';
}

/**
 * Mode jenjang yang dipakai HANYA untuk form tambah/edit.
 * - Admin SMP/SMK → terkunci ke jenjangnya
 * - Super Admin / jenjang all → mengikuti toggle schoolMode
 * Toggle filter data tetap bebas (tidak dikunci).
 */
function getFormSchoolMode() {
    if (!currentUser) return schoolMode;
    const j = normalizeJenjang(currentUser.jenjang);
    if (currentUser.role === 'superadmin' || j === 'all') return schoolMode;
    return j;
}

function getJenjangLabel(j) {
    const v = normalizeJenjang(j);
    if (v === 'smp') return 'SMP';
    if (v === 'smk') return 'SMK';
    return 'Semua';
}

/**
 * Apakah user boleh memakai toggle filter SMP/SMK?
 * - Tamu (belum login) → ya
 * - Super Admin / jenjang all → ya
 * - Admin SMP atau SMK → tidak (mode dikunci ke jenjang akun)
 */
function canUseSchoolToggle() {
    if (!currentUser) return true;
    if (currentUser.role === 'superadmin') return true;
    const j = normalizeJenjang(currentUser.jenjang);
    return j === 'all';
}

/**
 * Kunci schoolMode ke jenjang akun bila admin biasa.
 * Dipanggil saat login / update UI / load session.
 */
function applyUserJenjangMode() {
    if (!currentUser) {
        syncToggleVisibility();
        return;
    }
    if (currentUser.role === 'superadmin' || normalizeJenjang(currentUser.jenjang) === 'all') {
        syncToggleVisibility();
        return;
    }
    const locked = normalizeJenjang(currentUser.jenjang); // smp | smk
    if (schoolMode !== locked) {
        schoolMode = locked;
        try { localStorage.setItem('smpgelora_school_mode', locked); } catch (e) {}
        document.querySelectorAll('.school-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === locked);
        });
    }
    syncToggleVisibility();
    syncSchoolModeUI();
}

/** Tampilkan/sembunyikan bar toggle sesuai hak akses */
function syncToggleVisibility() {
    const bar = document.getElementById('school-mode-bar');
    if (!bar) return;
    bar.style.display = canUseSchoolToggle() ? '' : 'none';
}

/**
 * Sinkron UI form berdasarkan role guru (bukan toggle filter data).
 */
function syncFormSchoolUI() {
    const formMode = getFormSchoolMode();
    const showJurusan = formMode !== 'smp';
    const formGroupJurusan = document.getElementById('form-group-jurusan');
    const elJurusan = document.getElementById('jurusan');
    const elKelas = document.getElementById('kelas');
    const jurusanNote = document.getElementById('jurusan-note');
    const notice = document.getElementById('form-jenjang-notice');

    if (formGroupJurusan) {
        formGroupJurusan.style.display = showJurusan ? '' : 'none';
    }
    if (!showJurusan && elJurusan) {
        elJurusan.value = '';
    }

    if (elKelas) {
        if (formMode === 'smp') {
            elKelas.placeholder = 'Contoh: 7A / 8B / 9C';
        } else if (formMode === 'smk') {
            elKelas.placeholder = 'Contoh: X TKJ 1 / XI RPL 2';
        } else {
            elKelas.placeholder = 'Contoh: 8A / XI TKJ 1';
        }
    }

    if (jurusanNote) {
        jurusanNote.textContent = formMode === 'smk' ? '(wajib untuk SMK)' : '(opsional)';
    }

    if (notice) {
        // Notice form-jenjang tidak ditampilkan — mode sudah otomatis sesuai role
        notice.style.display = 'none';
        notice.innerHTML = '';
    }
}


function toggleAudio(){
    const audio = document.getElementById('bg-music');
    const text = document.getElementById('music-text');
    const icon = document.getElementById('music-icon');
    if(audio.paused){
        audio.volume = .2;
        audio.play().then(() => {
            text.textContent = "Hentikan Musik";
            icon.textContent = "🔇";
            Swal.fire({ icon: 'info', title: 'Musik Diputar', text: 'Musik latar belakang berhasil diputar.', timer: 1500, showConfirmButton: false });
        }).catch(err => { Swal.fire('Error Audio', 'Tidak dapat memutar audio: ' + err.message, 'error'); });
    } else {
        audio.pause();
        text.textContent = "Putar Musik";
        icon.textContent = "🎵";
    }
}

function getLocalDateISO(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getDefaultTahunAjaranSemester(date = new Date()) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    if (month >= 7) return { tahunAjaran: `${year}/${year + 1}`, semester: 'Ganjil' };
    return { tahunAjaran: `${year - 1}/${year}`, semester: 'Genap' };
}

function parseDateOnly(value) {
    const s = String(value || '').substring(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeName(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function formatTanggalIndonesia(tanggal) {
    if (!tanggal) return '-';
    const [tahun, bulan, hari] = tanggal.substring(0, 10).split('-');
    const namaBulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    return `${parseInt(hari)} ${namaBulan[parseInt(bulan) - 1]} ${tahun}`;
}

let photoLightboxItems = [];
let photoLightboxIndex = -1;
let photoLightboxTouchStartX = 0;
let photoLightboxTouchStartY = 0;

function getPhotoLightboxItems(){
    const source = filteredRecordsCache.length
        ? filteredRecordsCache
        : filterBySchoolMode(records);
    return source.filter(item => item && item.foto_url);
}

function renderPhotoLightboxItem(){
    const box = document.getElementById('photo-lightbox');
    const img = document.getElementById('photo-lightbox-img');
    const name = document.getElementById('photo-lightbox-name');
    const meta = document.getElementById('photo-lightbox-meta');
    const counter = document.getElementById('photo-lightbox-counter');
    const prev = document.getElementById('photo-lightbox-prev');
    const next = document.getElementById('photo-lightbox-next');
    if(!box || !img || photoLightboxIndex < 0 || photoLightboxIndex >= photoLightboxItems.length) return;

    const item = photoLightboxItems[photoLightboxIndex];
    img.src = item.foto_url;
    if(name) name.textContent = item.nama || '-';

    const metaParts = [
        item.kelas ? `Kelas ${item.kelas}` : '',
        item.jurusan ? item.jurusan : '',
        item.pelanggaran ? item.pelanggaran : '',
        item.tanggal ? formatTanggalIndonesia(item.tanggal) : ''
    ].filter(Boolean);
    if(meta) meta.textContent = metaParts.join(' · ');
    if(counter) counter.textContent = `${photoLightboxIndex + 1} / ${photoLightboxItems.length}`;

    const hasMultiple = photoLightboxItems.length > 1;
    if(prev){ prev.disabled = !hasMultiple; prev.style.display = hasMultiple ? '' : 'none'; }
    if(next){ next.disabled = !hasMultiple; next.style.display = hasMultiple ? '' : 'none'; }
}

function openPhotoLightboxById(id){
    const items = getPhotoLightboxItems();
    if(!items.length) return;
    const targetId = String(id);
    let index = items.findIndex(item => String(item.id) === targetId);

    if(index < 0){
        const target = records.find(item => String(item.id) === targetId && item && item.foto_url);
        if(target){ items.unshift(target); index = 0; }
    }
    if(index < 0) return;

    photoLightboxItems = items;
    photoLightboxIndex = index;
    const box = document.getElementById('photo-lightbox');
    if(!box) return;
    renderPhotoLightboxItem();
    box.classList.add('show');
    box.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function openPhotoLightbox(url, nameText){
    if(!url) return;
    const box = document.getElementById('photo-lightbox');
    const img = document.getElementById('photo-lightbox-img');
    const name = document.getElementById('photo-lightbox-name');
    const meta = document.getElementById('photo-lightbox-meta');
    const counter = document.getElementById('photo-lightbox-counter');
    const prev = document.getElementById('photo-lightbox-prev');
    const next = document.getElementById('photo-lightbox-next');
    if(!box || !img) return;

    // Foto bukti yang bukan record utama tetap memakai viewer tunggal.
    photoLightboxItems = [{id:null, foto_url:url, nama:nameText || '', kelas:'', pelanggaran:'', tanggal:''}];
    photoLightboxIndex = 0;
    img.src = url;
    if(name) name.textContent = nameText || '';
    if(meta) meta.textContent = '';
    if(counter) counter.textContent = '';
    if(prev) prev.style.display = 'none';
    if(next) next.style.display = 'none';
    box.classList.add('show');
    box.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function closePhotoLightbox(event){
    if(event && event.target && event.target.closest && event.target.closest('.photo-lightbox-content')) return;
    const box = document.getElementById('photo-lightbox');
    const img = document.getElementById('photo-lightbox-img');
    if(!box || !img) return;
    box.classList.remove('show');
    box.setAttribute('aria-hidden', 'true');
    img.src = '';
    photoLightboxItems = [];
    photoLightboxIndex = -1;
    document.body.style.overflow = '';
}

function photoLightboxPrev(){
    if(photoLightboxItems.length < 2) return;
    photoLightboxIndex = (photoLightboxIndex - 1 + photoLightboxItems.length) % photoLightboxItems.length;
    renderPhotoLightboxItem();
}

function photoLightboxNext(){
    if(photoLightboxItems.length < 2) return;
    photoLightboxIndex = (photoLightboxIndex + 1) % photoLightboxItems.length;
    renderPhotoLightboxItem();
}

function handlePhotoLightboxTouchStart(event){
    if(!event.touches || !event.touches.length) return;
    photoLightboxTouchStartX = event.touches[0].clientX;
    photoLightboxTouchStartY = event.touches[0].clientY;
}

function handlePhotoLightboxTouchEnd(event){
    if(!event.changedTouches || !event.changedTouches.length) return;
    const endX = event.changedTouches[0].clientX;
    const endY = event.changedTouches[0].clientY;
    const deltaX = endX - photoLightboxTouchStartX;
    const deltaY = endY - photoLightboxTouchStartY;
    photoLightboxTouchStartX = 0;
    photoLightboxTouchStartY = 0;
    if(photoLightboxItems.length < 2) return;
    if(Math.abs(deltaX) < 50 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    if(deltaX < 0) photoLightboxNext();
    else photoLightboxPrev();
}

document.addEventListener('keydown', function(e){
    const box = document.getElementById('photo-lightbox');
    if(!box || !box.classList.contains('show')) return;
    if(e.key === 'Escape') closePhotoLightbox();
    else if(e.key === 'ArrowLeft'){ e.preventDefault(); photoLightboxPrev(); }
    else if(e.key === 'ArrowRight'){ e.preventDefault(); photoLightboxNext(); }
});

document.addEventListener('DOMContentLoaded', function(){
    const box = document.getElementById('photo-lightbox');
    if(!box) return;
    box.addEventListener('touchstart', handlePhotoLightboxTouchStart, {passive:true});
    box.addEventListener('touchend', handlePhotoLightboxTouchEnd, {passive:true});
});


document.getElementById('tanggal').value = getLocalDateISO();


function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    document.getElementById('theme-toggle').textContent = isDark ? '☀️' : '🌙';
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    if(myChart) updateChart(records);
    if(typeof updateDashTrendChart === 'function') updateDashTrendChart();
}

if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark-mode');
    document.getElementById('theme-toggle').textContent = '☀️';
}

function openMenu() {
    document.getElementById('drawer-auth-text').textContent = currentUser ? 'Logout' : 'Login';
    document.getElementById('drawer-auth-icon').textContent = currentUser ? '🔒' : '🔑';
    document.getElementById('side-menu').classList.add('show');
}
function closeMenu() {
    document.getElementById('side-menu').classList.remove('show');
}
function showAbout() {
    Swal.fire({
        title: 'SMP - SMK Gelora Bekasi',
        html: '<p>Sistem Rekapitulasi Pelanggaran Siswa v2.0</p>' +
              '<p style="margin-top: 10px; font-weight: bold; color: #f97316;">Licensed By: Restu Putra Perdana</p>',
        icon: 'info',
        confirmButtonColor: '#f97316'
    });
}

function showPage(page){
    if (page === 'form' && currentUser) loadViolationPointRules();
    localStorage.setItem('smpgelora_current_page', page);
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById('page-' + page);
    if(target) target.classList.add('active');

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.page === page);
    });

    window.scrollTo({top:0,behavior:'smooth'});

    if(page === 'chart') updateChart(records);
    if(page === 'data') filterData();
    if(page === 'report') renderThreeStrikeReport();
    if(page === 'home'){
        updateStats();
        renderRecent();
    }
}

function openForm(){
    if(!currentUser){
        Swal.fire({
            icon: 'warning',
            title: 'Akses Terbatas',
            text: 'Fitur tambah data hanya dapat digunakan oleh Admin.',
            confirmButtonColor: '#f97316'
        }).then(() => openLogin());
        return;
    }
    batalEdit();
    syncFormSchoolUI();
    showPage('form');
}

function showLoginGate(){
    document.body.classList.add('auth-locked');
    const gate = document.getElementById('auth-gate');
    if(gate){ gate.classList.add('show'); gate.setAttribute('aria-hidden','false'); }
    setTimeout(()=>document.getElementById('login-username')?.focus(),120);
}
function hideLoginGate(){
    document.body.classList.remove('auth-locked');
    const gate = document.getElementById('auth-gate');
    if(gate){ gate.classList.remove('show'); gate.setAttribute('aria-hidden','true'); }
    const err = document.getElementById('login-gate-error');
    if(err) err.textContent = '';
}
function openLogin(){ showLoginGate(); }
function closeLogin(){
    if(currentUser) hideLoginGate();
    const u = document.getElementById('login-username');
    const pw = document.getElementById('login-password');
    if(u) u.value='';
    if(pw) pw.value='';
    const err = document.getElementById('login-gate-error');
    if(err) err.textContent='';
}
function togglePassword(inputId){
    const el=document.getElementById(inputId);
    el.type=el.type==='password'?'text':'password';
}

async function getCurrentAppUser(){
    const { data: { user }, error: authError } = await _supabase.auth.getUser();
    if (authError || !user) return null;

    const { data, error } = await _supabase
        .from('users')
        .select('id,username,nama,role,jenjang,auth_user_id')
        .eq('auth_user_id', user.id)
        .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Akun Auth belum terhubung ke akun aplikasi.');

    return {
        id: data.id,
        username: data.username,
        nama: data.nama,
        role: data.role,
        jenjang: normalizeJenjang(data.jenjang),
        auth_user_id: data.auth_user_id
    };
}

async function restoreAuthSession(){
    try {
        const { data: { session }, error } = await _supabase.auth.getSession();
        if (error) throw error;
        if (!session) {
            currentUser = null;
            authReady = true;
            return;
        }
        currentUser = await getCurrentAppUser();
        authReady = true;
    } catch (err) {
        console.error('Gagal memulihkan sesi Auth:', err);
        currentUser = null;
        authReady = true;
        try { await _supabase.auth.signOut({ scope: 'local' }); } catch (_) {}
    }
}

async function loginUser(){
    const u = document.getElementById('login-username').value.trim().toLowerCase();
    const p = document.getElementById('login-password').value;

    if(!u || !p){
        const gateError = document.getElementById('login-gate-error');
        if(gateError) gateError.textContent = 'Username dan kata sandi wajib diisi.';
        return Swal.fire({
            icon: 'warning',
            title: 'Perhatian',
            text: 'Username dan Password wajib diisi!',
            confirmButtonColor: '#f97316'
        });
    }

    try {
        const email = `${u}@smpgelora.local`;
        const { error } = await _supabase.auth.signInWithPassword({ email, password: p });
        if (error) throw error;

        currentUser = await getCurrentAppUser();
        if (!currentUser) throw new Error('Profil aplikasi tidak ditemukan.');

        authReady = true;
        await loadData();
        closeLogin();
        applyUserJenjangMode();
        updateAdminUI();
        syncFormSchoolUI();
        refreshViews({ stats: true, recent: true, data: true });

        Swal.fire({
            icon: 'success',
            title: 'Berhasil Login!',
            text: `Selamat datang, ${currentUser.nama}` +
                  (currentUser.jenjang && currentUser.jenjang !== 'all'
                    ? ` (${getJenjangLabel(currentUser.jenjang)})`
                    : ''),
            timer: 1800,
            showConfirmButton: false
        });
    } catch (err) {
        console.error('Login gagal:', err);
        currentUser = null;

        const rawMessage = String(err?.message || err?.error_description || err || 'Kesalahan tidak diketahui');
        const status = Number(err?.status || 0);
        const lowerMessage = rawMessage.toLowerCase();
        let detail = rawMessage;

        if (lowerMessage.includes('invalid login credentials')) {
            detail = 'Kredensial Auth ditolak. Pastikan username benar dan password yang dipakai adalah password akun Supabase Auth.';
        } else if (lowerMessage.includes('email not confirmed')) {
            detail = 'Akun Auth belum dikonfirmasi. Periksa status Confirmed/Email Confirmed pada Supabase Authentication.';
        } else if (lowerMessage.includes('user not found')) {
            detail = 'Akun Auth dengan email tersebut tidak ditemukan.';
        } else if (rawMessage === 'Profil aplikasi tidak ditemukan.') {
            detail = 'Login Auth berhasil, tetapi profil pada tabel public.users tidak ditemukan atau auth_user_id tidak cocok.';
        } else if (status >= 500) {
            detail = `Server Auth mengembalikan error (HTTP ${status}). Coba lagi dan periksa log Supabase bila tetap gagal.`;
        }

        const gateError = document.getElementById('login-gate-error');
        if(gateError) gateError.textContent = detail;
        Swal.fire({
            icon: 'error',
            title: 'Gagal Login',
            html: `<div style="text-align:left"><b>Detail:</b><br>${escapeHtml(detail)}</div>`,
            confirmButtonColor: '#e53935'
        });
    }
}


async function toggleAdminAuth(){
    if(currentUser){
        Swal.fire({
            title: 'Konfirmasi Logout',
            text: 'Apakah Anda yakin ingin keluar dari sistem?',
            icon: 'question',
            showCancelButton: true,
            confirmButtonColor: '#e53935',
            confirmButtonText: 'Ya, Logout',
            cancelButtonText: 'Batal'
        }).then(async (result) => {
            if (result.isConfirmed) {
                try { await _supabase.auth.signOut(); } catch (err) { console.warn('Logout Auth:', err); }
                currentUser = null;
                authReady = true;
                appDataLoaded = false;
                records = [];
                filteredRecordsCache = [];
                syncToggleVisibility();
                updateAdminUI();
                refreshViews({ stats: true, recent: true, data: true });
                showLoginGate();
                Swal.fire({
                    icon: 'info',
                    title: 'Logout',
                    text: 'Anda telah keluar dari sistem.',
                    timer: 1500,
                    showConfirmButton: false
                });
            }
        });
    } else openLogin();
}

function updateAdminUI(){
    const badge = document.getElementById('status-badge');
    const authBtn = document.getElementById('btn-auth-home');
    const manageUserBtn = document.getElementById('drawer-manage-user');
    const auditLogBtn = document.getElementById('drawer-audit-log');
    const manageCategoryBtn = document.getElementById('drawer-manage-category');
    const dbMaintenanceBtn = document.getElementById('drawer-db-maintenance');
    const userInfoText = document.getElementById('user-info-text');
    const loggedUsername = document.getElementById('logged-username');

    const inputs = document.querySelectorAll('#page-form input, #page-form select');
    const save = document.getElementById('btn-save');
    const notice = document.getElementById('guest-notice');

    const guestLabel = document.getElementById('guest-label');

    if(currentUser){
        if(userInfoText) userInfoText.style.display = 'block';
        if(guestLabel) guestLabel.style.display = 'none';
        if(loggedUsername) {
            const jLabel = getJenjangLabel(currentUser.jenjang);
            loggedUsername.textContent = currentUser.jenjang && currentUser.jenjang !== 'all'
                ? `${currentUser.nama} · ${jLabel}`
                : `${currentUser.nama}`;
        }
        if(authBtn) authBtn.textContent = 'Keluar';
        inputs.forEach(x => x.disabled = false);
        if(save) save.disabled = false;
        if(notice) notice.style.display = 'none';

        // Admin & Super Admin boleh kelola klasifikasi
        if(manageCategoryBtn) manageCategoryBtn.style.display = 'flex';

        const archiveBtn = document.getElementById('drawer-archive');
        if(currentUser.role === 'superadmin'){
            if(badge){ badge.textContent = 'Super Admin'; badge.className = 'badge superadmin'; }
            if(manageUserBtn) manageUserBtn.style.display = 'flex';
            if(auditLogBtn) auditLogBtn.style.display = 'flex';
            if(archiveBtn) archiveBtn.style.display = 'flex';
            if(dbMaintenanceBtn) dbMaintenanceBtn.style.display = 'flex';
        } else {
            if(badge){ badge.textContent = 'Admin'; badge.className = 'badge admin'; }
            if(manageUserBtn) manageUserBtn.style.display = 'none';
            if(auditLogBtn) auditLogBtn.style.display = 'none';
            if(archiveBtn) archiveBtn.style.display = 'none';
            if(dbMaintenanceBtn) dbMaintenanceBtn.style.display = 'none';
        }
    } else {
        if(userInfoText) userInfoText.style.display = 'none';
        if(guestLabel) guestLabel.style.display = 'block';
        if(badge){ badge.textContent = 'Tamu'; badge.className = 'badge guest'; }
        if(authBtn) authBtn.textContent = 'Login';
        inputs.forEach(x => x.disabled = true);
        if(save) save.disabled = true;
        if(notice) notice.style.display = 'block';
        if(manageUserBtn) manageUserBtn.style.display = 'none';
        if(auditLogBtn) auditLogBtn.style.display = 'none';
        if(manageCategoryBtn) manageCategoryBtn.style.display = 'none';
        const archiveBtnGuest = document.getElementById('drawer-archive');
        if(archiveBtnGuest) archiveBtnGuest.style.display = 'none';
        if(dbMaintenanceBtn) dbMaintenanceBtn.style.display = 'none';
        batalEdit();
    }

    applyUserJenjangMode();
    refreshViews({ stats: true, recent: true, data: true });
    syncFormSchoolUI();
}

async function openManageUserModal(){
    if(!currentUser || currentUser.role !== 'superadmin'){
        return Swal.fire({
            icon: 'error',
            title: 'Akses Ditolak',
            text: 'Hanya Super Admin yang dapat mengakses menu ini.',
            confirmButtonColor: '#e53935'
        });
    }
    document.getElementById('user-modal').classList.add('show');
    batalEditUser();
    await loadUsers();
}
function closeManageUserModal(){
    document.getElementById('user-modal').classList.remove('show');
}

/* FUNGSI LOG AKTIVITAS (AUDIT LOG) */
async function catatLog(aksi, keterangan) {
    if (!currentUser) return;
    try {
        await _supabase.from('audit_logs').insert([{
            username: currentUser.username,
            nama_user: currentUser.nama,
            aksi: aksi,
            keterangan: keterangan
        }]);
    } catch (err) {
        console.error("Gagal mencatat log:", err);
    }
}

async function openLogModal() {
    if (!currentUser || currentUser.role !== 'superadmin') {
        return Swal.fire({
            icon: 'error',
            title: 'Akses Ditolak',
            text: 'Hanya Super Admin yang dapat melihat log.',
            confirmButtonColor: '#e53935'
        });
    }
    document.getElementById('log-modal').classList.add('show');
    await loadAuditLogs();
}

function closeLogModal() {
    document.getElementById('log-modal').classList.remove('show');
}

async function loadAuditLogs() {
    const tbody = document.getElementById('log-table-body');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Memuat data...</td></tr>';

    const { data, error } = await _supabase
        .from('audit_logs')
        .select('*')
        .order('id', { ascending: false })
        .limit(50);

    if (error) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:red;">Gagal memuat log.</td></tr>';
        return;
    }

    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Belum ada catatan aktivitas.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(l => {
        const tgl = new Date(l.created_at).toLocaleString('id-ID', {
            dateStyle: 'short', timeStyle: 'short'
        });
        
        let color = '#f97316';
        if (l.aksi === 'TAMBAH') color = '#21a366';
        if (l.aksi === 'EDIT') color = '#f5b400';
        if (l.aksi === 'HAPUS') color = '#e53935';

        return `
            <tr>
                <td style="font-size: 11px; white-space: nowrap;">${tgl}</td>
                <td><strong>${escapeHtml(l.nama_user)}</strong><br><small style="color:var(--muted)">@${escapeHtml(l.username)}</small></td>
                <td><span class="badge" style="background:${color}">${l.aksi}</span></td>
                <td style="font-size: 11px;">${escapeHtml(l.keterangan)}</td>
            </tr>
        `;
    }).join('');
}

async function loadUsers(){
    const { data, error } = await _supabase.from('users').select('id,username,nama,role,jenjang,auth_user_id').order('id', {ascending: true});
    if(error) {
        Swal.fire('Error', 'Gagal memuat daftar user: ' + error.message, 'error');
        return;
    }
    usersList = data || [];
    const tbody = document.getElementById('user-table-body');
    tbody.innerHTML = usersList.map(u => {
        const jenjang = normalizeJenjang(u.jenjang);
        const jenjangBadge = jenjang === 'smp'
            ? '<span class="badge" style="background:#0ea5e9">SMP</span>'
            : jenjang === 'smk'
            ? '<span class="badge" style="background:#8b5cf6">SMK</span>'
            : '<span class="badge" style="background:#64748b">Semua</span>';
        const isSelf = u.username === currentUser.username;
        return `
        <tr>
            <td>${escapeHtml(u.nama)}</td>
            <td>@${escapeHtml(u.username)}</td>
            <td><span class="badge ${u.role === 'superadmin' ? 'superadmin' : 'admin'}">${u.role}</span></td>
            <td>${jenjangBadge}</td>
            <td style="white-space:nowrap;">
                <button class="edit-btn" style="padding:4px 8px; margin-right:4px;" onclick="editUser(${u.id})">Edit</button>
                ${!isSelf ? `<button class="delete-btn" style="padding:4px 8px" onclick="hapusUser(${u.id}, '${escapeAttr(u.nama)}')">Hapus</button>` : '<span style="color:var(--muted);font-size:11px;">(Anda)</span>'}
            </td>
        </tr>`;
    }).join('');
}

function editUser(id){
    const u = usersList.find(x => String(x.id) === String(id));
    if(!u) return;
    document.getElementById('user-edit-id').value = u.id;
    document.getElementById('new-nama').value = u.nama || '';
    document.getElementById('new-username').value = u.username || '';
    document.getElementById('new-username').disabled = true;
    const pw = document.getElementById('new-password');
    if(pw){
        pw.value = '';
        pw.placeholder = 'Password tidak diubah saat edit';
        pw.disabled = true;
    }
    document.getElementById('new-role').value = u.role === 'superadmin' ? 'superadmin' : 'admin';
    document.getElementById('new-jenjang').value = normalizeJenjang(u.jenjang);
    document.getElementById('user-form-title').textContent = '✏️ Edit User';
    document.getElementById('btn-simpan-user').textContent = '🔄 Update User';
    document.getElementById('btn-batal-user').style.display = 'block';
}

function batalEditUser(){
    document.getElementById('user-edit-id').value = '';
    document.getElementById('new-nama').value = '';
    document.getElementById('new-username').value = '';
    document.getElementById('new-username').disabled = false;
    const pw = document.getElementById('new-password');
    if(pw){
        pw.value = '';
        pw.placeholder = 'Password awal (min. 6 karakter)';
        pw.disabled = false;
    }
    document.getElementById('new-role').value = 'admin';
    document.getElementById('new-jenjang').value = 'smp';
    document.getElementById('user-form-title').textContent = '➕ Tambah User Baru';
    document.getElementById('btn-simpan-user').textContent = '💾 Simpan User';
    document.getElementById('btn-batal-user').style.display = 'none';
}

async function invokeUserAdminFunction(functionName, body){
    const { data, error } = await _supabase.functions.invoke(functionName, { body });
    if(!error) return data || {};

    let detail = error.message || String(error);
    try{
        const context = error.context;
        if(context && typeof context.json === 'function'){
            const payload = await context.json();
            if(payload?.error) detail = payload.error;
        }
    }catch(_){}
    throw new Error(detail);
}

async function simpanUser(){
    if(!currentUser || currentUser.role !== 'superadmin'){
        return Swal.fire({ icon:'error', title:'Akses Ditolak', text:'Hanya Super Admin.', confirmButtonColor:'#e53935' });
    }

    const editId = document.getElementById('user-edit-id').value;
    const nama = document.getElementById('new-nama').value.trim();
    const username = document.getElementById('new-username').value.trim().toLowerCase();
    const passwordEl = document.getElementById('new-password');
    const password = passwordEl ? passwordEl.value : '';
    const role = document.getElementById('new-role').value;
    let jenjang = normalizeJenjang(document.getElementById('new-jenjang')?.value || 'all');
    if(role === 'superadmin') jenjang = 'all';

    if(!nama || !username){
        return Swal.fire({
            icon:'warning',
            title:'Data Belum Lengkap',
            text:'Nama dan Username wajib diisi!',
            confirmButtonColor:'#f97316'
        });
    }

    if(!editId){
        if(!/^[a-z0-9._-]{3,32}$/.test(username)){
            return Swal.fire({
                icon:'warning',
                title:'Username Tidak Valid',
                text:'Username 3–32 karakter dan hanya boleh berisi huruf kecil, angka, titik, garis bawah, atau tanda minus.',
                confirmButtonColor:'#f97316'
            });
        }
        if(password.length < 6 || password.length > 72){
            return Swal.fire({
                icon:'warning',
                title:'Password Tidak Valid',
                text:'Password harus 6–72 karakter.',
                confirmButtonColor:'#f97316'
            });
        }

        const confirm = await Swal.fire({
            title:'Buat User Baru?',
            html:`<div style="text-align:left">Nama: <b>${escapeHtml(nama)}</b><br>Username: <b>@${escapeHtml(username)}</b><br>Role: <b>${escapeHtml(role)}</b><br>Jenjang: <b>${escapeHtml(getJenjangLabel(jenjang))}</b></div>`,
            icon:'question',
            showCancelButton:true,
            confirmButtonColor:'#21a366',
            cancelButtonColor:'#6c757d',
            confirmButtonText:'Ya, Buat User',
            cancelButtonText:'Batal'
        });
        if(!confirm.isConfirmed) return;

        try{
            Swal.fire({
                title:'Membuat User...',
                text:'Akun Authentication dan profil aplikasi sedang dibuat.',
                allowOutsideClick:false,
                allowEscapeKey:false,
                didOpen:()=>Swal.showLoading()
            });

            await invokeUserAdminFunction('admin-create-user', {
                nama,
                username,
                password,
                role,
                jenjang
            });

            batalEditUser();
            await loadUsers();

            Swal.fire({
                icon:'success',
                title:'User Berhasil Dibuat',
                html:`Akun <b>@${escapeHtml(username)}</b> sudah aktif dan siap login.<br><small style="color:var(--muted)">Password tidak disimpan di tabel aplikasi.</small>`,
                confirmButtonColor:'#21a366'
            });
        }catch(err){
            Swal.fire({
                icon:'error',
                title:'Gagal Membuat User',
                text:err.message || String(err),
                confirmButtonColor:'#e53935'
            });
        }
        return;
    }

    try{
        const payload = { nama, role, jenjang };
        const { error } = await _supabase.from('users').update(payload).eq('id', editId);
        if(error) throw error;

        await catatLog('EDIT', `Mengubah user: ${nama} (@${username}) → ${role} / ${jenjang}`);

        if(String(currentUser.id) === String(editId)){
            currentUser.nama = nama;
            currentUser.role = role;
            currentUser.jenjang = jenjang;
            applyUserJenjangMode();
            updateAdminUI();
        }

        Swal.fire({
            icon:'success',
            title:'Berhasil',
            text:`User ${nama} diperbarui (${getJenjangLabel(jenjang)}).`,
            confirmButtonColor:'#21a366'
        });
        batalEditUser();
        await loadUsers();
    }catch(err){
        Swal.fire({
            icon:'error',
            title:'Gagal Menyimpan',
            text:err.message || String(err),
            confirmButtonColor:'#e53935'
        });
    }
}

// Alias lama biar tidak error jika masih terpanggil
async function tambahUserBaru(){ return simpanUser(); }

async function hapusUser(id, namaUser){
    if(!currentUser || currentUser.role !== 'superadmin'){
        return Swal.fire({ icon:'error', title:'Akses Ditolak', text:'Hanya Super Admin.', confirmButtonColor:'#e53935' });
    }
    if(String(id) === String(currentUser.id)){
        return Swal.fire({ icon:'warning', title:'Tidak diizinkan', text:'Tidak bisa menghapus akun sendiri.', confirmButtonColor:'#f97316' });
    }

    const confirm = await Swal.fire({
        title:'Hapus User?',
        text:`User ${namaUser} akan dihapus dari Authentication dan aplikasi.`,
        icon:'warning',
        showCancelButton:true,
        confirmButtonColor:'#e53935',
        cancelButtonColor:'#6c757d',
        confirmButtonText:'Ya, Hapus',
        cancelButtonText:'Batal'
    });
    if(!confirm.isConfirmed) return;

    try{
        Swal.fire({
            title:'Menghapus User...',
            text:'Menghapus akun Authentication dan profil aplikasi.',
            allowOutsideClick:false,
            allowEscapeKey:false,
            didOpen:()=>Swal.showLoading()
        });

        await invokeUserAdminFunction('admin-delete-user', { id });

        if(document.getElementById('user-edit-id').value === String(id)) batalEditUser();
        await loadUsers();

        Swal.fire({
            icon:'success',
            title:'User Terhapus',
            text:`User ${namaUser} berhasil dihapus.`,
            confirmButtonColor:'#21a366'
        });
    }catch(err){
        Swal.fire({
            icon:'error',
            title:'Gagal Menghapus User',
            text:err.message || String(err),
            confirmButtonColor:'#e53935'
        });
    }
}

/* ========== KELOLA ATURAN POIN RESMI ========== */

async function loadViolationCategories(){
    // Dipertahankan hanya untuk kompatibilitas fungsi audit lama; bukan sumber klasifikasi resmi.
    try{
        const { data, error } = await _supabase.from('violation_categories').select('*').order('name', { ascending: true });
        if(error) throw error;
        violationCategories = data || [];
    }catch(err){
        console.warn('Kategori legacy tidak dimuat (tidak dipakai untuk klasifikasi resmi):', err.message || err);
        violationCategories = [];
    }
}

async function loadAllViolationPointRules(force = false){
    if(violationPointRulesAllLoaded && !force) return violationPointRulesAll;
    const { data, error } = await _supabase
        .from('violation_point_rules')
        .select('code,name,severity,points,accumulation_scope,active')
        .order('code', { ascending: true });
    if(error) throw error;
    violationPointRulesAll = Array.isArray(data) ? data : [];
    violationPointRulesAllLoaded = true;
    return violationPointRulesAll;
}

async function openCategoryModal(){
    if(!currentUser){
        return Swal.fire({icon:'warning', title:'Akses Admin', text:'Login terlebih dahulu untuk mengelola aturan poin resmi.', confirmButtonColor:'#f97316'});
    }
    document.getElementById('category-modal').classList.add('show');
    batalEditKategori();
    await renderCategoryTable();
}

function closeCategoryModal(){
    document.getElementById('category-modal').classList.remove('show');
    batalEditKategori();
}

function scopeLabel(scope){
    const labels = { school_year:'Tahun ajaran berjalan', all_school_years:'Lintas tahun ajaran', until_graduation:'Sampai lulus' };
    return labels[String(scope || '')] || String(scope || '—');
}

function defaultScopeForSeverity(severity){
    const value = String(severity || '').toLowerCase();
    if(value === 'ringan') return 'school_year';
    if(value === 'sedang') return 'all_school_years';
    return 'until_graduation';
}

function onRuleSeverityChange(){
    const severity = document.getElementById('rule-severity')?.value || 'Ringan';
    const scope = document.getElementById('rule-scope');
    if(scope) scope.value = defaultScopeForSeverity(severity);
}

async function renderCategoryTable(){
    const tbody = document.getElementById('category-table-body');
    if(!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Memuat aturan poin resmi...</td></tr>';
    try{
        await loadAllViolationPointRules(true);
        if(!violationPointRulesAll.length){
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Belum ada aturan poin resmi.</td></tr>';
            return;
        }
        tbody.innerHTML = violationPointRulesAll.map(rule => {
            const active = rule.active === true;
            return `<tr>
                <td><strong>${escapeHtml(rule.code)}</strong></td>
                <td style="min-width:190px;white-space:normal;">${escapeHtml(rule.name)}</td>
                <td>${escapeHtml(rule.severity)}</td>
                <td style="white-space:nowrap;">${Number(rule.points) || 0} poin</td>
                <td class="rule-status-scope-cell"><div class="rule-status-scope"><span class="badge ${active ? 'admin' : 'guest'}">${active ? 'Aktif' : 'Nonaktif'}</span><span class="rule-scope-label">${escapeHtml(scopeLabel(rule.accumulation_scope))}</span></div></td>
                <td style="white-space:nowrap;">
                    <button class="edit-btn" style="padding:5px 8px;margin-right:4px;" onclick="editKategori('${escapeAttr(rule.code)}')">Edit</button>
                    <button class="${active ? 'delete-btn' : 'success-btn'}" style="padding:5px 8px;" onclick="toggleRuleActive('${escapeAttr(rule.code)}', ${active ? 'false' : 'true'})">${active ? 'Nonaktifkan' : 'Aktifkan'}</button>
                </td>
            </tr>`;
        }).join('');
    }catch(err){
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#dc2626;">Gagal memuat aturan: ${escapeHtml(err.message || String(err))}</td></tr>`;
    }
}

function editKategori(code){
    const rule = violationPointRulesAll.find(item => String(item.code) === String(code));
    if(!rule) return;
    document.getElementById('rule-edit-code').value = rule.code;
    document.getElementById('rule-code').value = rule.code;
    document.getElementById('rule-code').disabled = true;
    document.getElementById('rule-name').value = rule.name || '';
    document.getElementById('rule-severity').value = rule.severity || 'Ringan';
    document.getElementById('rule-points').value = Number(rule.points) || 0;
    document.getElementById('rule-scope').value = rule.accumulation_scope || defaultScopeForSeverity(rule.severity);
    document.getElementById('rule-active').checked = rule.active === true;
    document.getElementById('btn-batal-kategori').style.display = 'block';
    document.getElementById('btn-simpan-aturan').textContent = '💾 Simpan Perubahan';
    document.getElementById('rule-name').focus();
}

function batalEditKategori(){
    const edit = document.getElementById('rule-edit-code');
    const code = document.getElementById('rule-code');
    if(edit) edit.value = '';
    if(code){ code.value = ''; code.disabled = false; }
    const name = document.getElementById('rule-name'); if(name) name.value = '';
    const severity = document.getElementById('rule-severity'); if(severity) severity.value = 'Ringan';
    const points = document.getElementById('rule-points'); if(points) points.value = '5';
    const scope = document.getElementById('rule-scope'); if(scope) scope.value = 'school_year';
    const active = document.getElementById('rule-active'); if(active) active.checked = true;
    const cancel = document.getElementById('btn-batal-kategori'); if(cancel) cancel.style.display = 'none';
    const save = document.getElementById('btn-simpan-aturan'); if(save) save.textContent = '➕ Tambah Aturan Resmi';
}

async function simpanKategori(){
    if(!currentUser) return;
    const editCode = document.getElementById('rule-edit-code').value.trim();
    const code = document.getElementById('rule-code').value.trim().toUpperCase();
    const name = document.getElementById('rule-name').value.trim();
    const severity = document.getElementById('rule-severity').value;
    const points = Number(document.getElementById('rule-points').value);
    const accumulation_scope = document.getElementById('rule-scope').value;
    const active = document.getElementById('rule-active').checked;
    if(!code || !/^[A-Z][A-Z0-9_-]{0,19}$/.test(code)) return Swal.fire({icon:'warning', title:'Kode aturan tidak valid', text:'Gunakan kode unik, misalnya R11, S10, atau B16.'});
    if(!name) return Swal.fire({icon:'warning', title:'Nama aturan wajib diisi'});
    if(!['Ringan','Sedang','Berat'].includes(severity)) return Swal.fire({icon:'warning', title:'Kategori tidak valid'});
    const expectedPrefix = severity === 'Ringan' ? 'R' : severity === 'Sedang' ? 'S' : 'B';
    if(!code.startsWith(expectedPrefix)) return Swal.fire({icon:'warning', title:'Kode dan klasifikasi tidak cocok', text:`Aturan kategori ${severity} harus menggunakan kode berawalan ${expectedPrefix}.`});
    if(!Number.isInteger(points) || points < 0) return Swal.fire({icon:'warning', title:'Poin tidak valid', text:'Poin harus berupa bilangan bulat nol atau lebih.'});
    if(!['school_year','all_school_years','until_graduation'].includes(accumulation_scope)) return Swal.fire({icon:'warning', title:'Masa akumulasi tidak valid'});
    if(!editCode && violationPointRulesAll.some(rule => String(rule.code).toUpperCase() === code)) return Swal.fire({icon:'warning', title:'Kode sudah digunakan', text:'Gunakan kode baru yang belum ada.'});
    const payload = { code, name, severity, points, accumulation_scope, active, updated_at:new Date().toISOString() };
    try{
        let result;
        if(editCode){
            result = await _supabase.from('violation_point_rules').update(payload).eq('code', editCode);
        }else{
            result = await _supabase.from('violation_point_rules').insert([payload]);
        }
        if(result.error) throw result.error;
        await catatLog(editCode ? 'EDIT' : 'TAMBAH', `${editCode ? 'Mengubah' : 'Menambah'} aturan poin resmi ${code}: ${name} (${points} poin, ${severity})`);
        // Refresh policy cache for new records; historical snapshot items remain unchanged.
        violationPointRulesLoaded = false;
        violationPointRulesAllLoaded = false;
        await loadViolationPointRules(true);
        await loadAllViolationPointRules(true);
        await loadViolationPointItems();
        batalEditKategori();
        await renderCategoryTable();
        updateStats();
        updateChart(records);
        renderThreeStrikeReport();
        Swal.fire({icon:'success', title:'Aturan tersimpan', text:'Aturan resmi diperbarui. Snapshot poin pada catatan lama tidak diubah.', timer:1700, showConfirmButton:false});
    }catch(err){
        Swal.fire({icon:'error', title:'Gagal menyimpan aturan', text:err.message || String(err), confirmButtonColor:'#e53935'});
    }
}

async function toggleRuleActive(code, active){
    if(!currentUser) return;
    const rule = violationPointRulesAll.find(item => String(item.code) === String(code));
    if(!rule) return;
    const action = active ? 'mengaktifkan' : 'menonaktifkan';
    const confirm = await Swal.fire({
        icon:'question', title:`${active ? 'Aktifkan' : 'Nonaktifkan'} aturan ${escapeHtml(code)}?`,
        text: active ? 'Aturan akan tersedia untuk input pelanggaran baru.' : 'Aturan tidak akan tersedia untuk input baru. Catatan historis dan snapshot lama tetap disimpan.',
        showCancelButton:true, confirmButtonText:active ? 'Aktifkan' : 'Nonaktifkan', cancelButtonText:'Batal', confirmButtonColor:active ? '#16a34a' : '#dc2626'
    });
    if(!confirm.isConfirmed) return;
    try{
        const { error } = await _supabase.from('violation_point_rules').update({active, updated_at:new Date().toISOString()}).eq('code', code);
        if(error) throw error;
        await catatLog(active ? 'AKTIFKAN' : 'NONAKTIFKAN', `${action} aturan poin resmi ${code}: ${rule.name}`);
        violationPointRulesLoaded = false;
        violationPointRulesAllLoaded = false;
        await loadViolationPointRules(true);
        await loadAllViolationPointRules(true);
        await renderCategoryTable();
        updateChart(records);
        updateStats();
        Swal.fire({icon:'success', title:'Status aturan diperbarui', timer:1200, showConfirmButton:false});
    }catch(err){
        Swal.fire({icon:'error', title:'Gagal mengubah status aturan', text:err.message || String(err)});
    }
}

function getDashboardDateRange(period){
    const now = new Date();
    const today = getLocalDateISO(now);
    if(period === 'today'){
        return { from: today, to: today, label: 'Hari ini' };
    }
    if(period === 'week'){
        const d = new Date(now);
        const day = d.getDay() || 7; // Senin=1 ... Minggu=7
        d.setDate(d.getDate() - (day - 1));
        return { from: getLocalDateISO(d), to: today, label: 'Minggu ini' };
    }
    if(period === 'month'){
        const from = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
        return { from, to: today, label: 'Bulan ini' };
    }
    if(period === 'semester'){
        const { tahunAjaran, semester } = getDefaultTahunAjaranSemester();
        return { from: null, to: null, label: 'Semester ' + semester, tahunAjaran, semester };
    }
    return { from: null, to: null, label: 'Semua catatan' };
}

function filterRecordsForDashboard(list){
    const arr = filterBySchoolMode(Array.isArray(list) ? list : []);
    const range = getDashboardDateRange(dashboardPeriod);
    if(dashboardPeriod === 'all') return arr;
    if(dashboardPeriod === 'semester'){
        const ta = normTA(range.tahunAjaran);
        const sem = String(range.semester || '').toLowerCase();
        return arr.filter(item => {
            if(normTA(item.tahun_ajaran) !== ta) return false;
            if(sem && String(item.semester || '').trim().toLowerCase() !== sem) return false;
            return true;
        });
    }
    return arr.filter(item => {
        const tgl = String(item.tanggal || '').substring(0, 10);
        if(!tgl) return false;
        if(range.from && tgl < range.from) return false;
        if(range.to && tgl > range.to) return false;
        return true;
    });
}

function setDashboardPeriod(period){
    if(!['all','today','week','month','semester'].includes(period)) period = 'all';
    dashboardPeriod = period;
    document.querySelectorAll('.dash-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
    });
    updateStats();
    renderDashboardPanels();
    updateDashTrendChart();
}

function updateStats(){
    const scoped = filterRecordsForDashboard(records);
    const range = getDashboardDateRange(dashboardPeriod);

    const elTotal = document.getElementById('stat-total');
    if(elTotal) elTotal.textContent = scoped.length;
    const elTotalSub = document.getElementById('stat-total-sub');
    if(elTotalSub) elTotalSub.textContent = range.label;

    const officialRuleSet = new Set();
    scoped.forEach(item => getRecordPointItems(item.id).forEach(point => {
        if(point.violation_code) officialRuleSet.add(String(point.violation_code));
    }));
    const elTypes = document.getElementById('stat-types');
    if(elTypes) elTypes.textContent = officialRuleSet.size;

    // 3x students (selalu per TA aktif, tidak terpengaruh filter hari/minggu)
    const three = getThreeStrikeStudents();
    const actedStudents = three.filter(g => {
        const follow = getThreeStrikeFollowUp(g).follow;
        return follow.status && follow.status !== 'Belum Ditindak';
    });
    const elActed = document.getElementById('stat-acted');
    if(elActed) elActed.textContent = actedStudents.length;
    const elThree = document.getElementById('stat-three');
    if(elThree) elThree.textContent = three.length;

    const { tahunAjaran, semester } = getDefaultTahunAjaranSemester();
    const elSem = document.getElementById('stat-semester');
    if(elSem) elSem.textContent = 'TA ' + String(tahunAjaran).replace('/', '-');

    // Panel & tren ikut ter-refresh
    renderDashboardPanels();
    updateDashTrendChart();
}

/** Siswa dengan tepat 2x pelanggaran di TA aktif (hampir 3x) */
function getNearStrikeStudents(){
    const groups = {};
    const targetTA = normTA(getDefaultTahunAjaranSemester().tahunAjaran);
    filterBySchoolMode(records).forEach(item => {
        if(normTA(item.tahun_ajaran) !== targetTA) return;
        const nama = String(item.nama || '').trim();
        if(!nama) return;
        const key = normalizeName(nama);
        if(!groups[key]){
            groups[key] = { nama, kelas: String(item.kelas||'').trim()||'-', records: [] };
        }
        groups[key].records.push(item);
        const kelas = String(item.kelas||'').trim();
        if(kelas) groups[key].kelas = kelas;
    });
    return Object.values(groups)
        .filter(g => g.records.length === 2)
        .sort((a,b) => a.nama.localeCompare(b.nama, 'id'))
        .slice(0, 8);
}

function renderDashboardPanels(){
    const attBox = document.getElementById('dash-attention-list');
    const actBox = document.getElementById('dash-acted-list');
    if(attBox){
        const near = getNearStrikeStudents();
        if(!near.length){
            attBox.innerHTML = '<div class="dash-empty">Tidak ada siswa 2x di TA ini 👍</div>';
        } else {
            attBox.innerHTML = near.map(g => `
                <div class="dash-item" onclick="showPage('report')">
                    <div class="dash-item-main">
                        <div class="dash-item-name">${escapeHtml(g.nama)}</div>
                        <div class="dash-item-meta">Kelas ${escapeHtml(g.kelas)} · ${g.records.length}x</div>
                    </div>
                    <span class="dash-item-badge warn">2x</span>
                </div>
            `).join('');
        }
    }
    if(actBox){
        const three = getThreeStrikeStudents();
        const acted = three
            .map(g => {
                const { follow } = getThreeStrikeFollowUp(g);
                return { g, follow };
            })
            .filter(x => x.follow.status && x.follow.status !== 'Belum Ditindak')
            .sort((a,b) => String(b.follow.updated_at||b.follow.tanggal||'').localeCompare(String(a.follow.updated_at||a.follow.tanggal||'')))
            .slice(0, 8);
        if(!acted.length){
            actBox.innerHTML = '<div class="dash-empty">Belum ada tindak lanjut tercatat</div>';
        } else {
            actBox.innerHTML = acted.map(({g, follow}) => `
                <div class="dash-item" onclick="showPage('report')">
                    <div class="dash-item-main">
                        <div class="dash-item-name">${escapeHtml(g.nama)}</div>
                        <div class="dash-item-meta">${escapeHtml(follow.status)}${follow.oleh ? ' · ' + escapeHtml(follow.oleh) : ''}</div>
                    </div>
                    <span class="dash-item-badge ${follow.status.includes('Selesai') ? 'ok' : 'danger'}">${escapeHtml((follow.tanggal||'').substring(0,10) || '—')}</span>
                </div>
            `).join('');
        }
    }
}

function updateDashTrendChart(){
    const canvas = document.getElementById('dashTrendChart');
    if(!canvas || typeof Chart === 'undefined') return;

    const days = [];
    const counts = [];
    const now = new Date();
    for(let i = 6; i >= 0; i--){
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const iso = getLocalDateISO(d);
        days.push(iso);
        counts.push(0);
    }
    const scoped = filterBySchoolMode(records);
    scoped.forEach(item => {
        const tgl = String(item.tanggal || '').substring(0, 10);
        const idx = days.indexOf(tgl);
        if(idx >= 0) counts[idx]++;
    });

    const labels = days.map(iso => {
        const [, m, d] = iso.split('-');
        return `${parseInt(d,10)}/${parseInt(m,10)}`;
    });
    const totalWeek = counts.reduce((a,b)=>a+b,0);
    const elLabel = document.getElementById('dash-trend-label');
    if(elLabel) elLabel.textContent = `${totalWeek} kasus · 7 hari`;

    const isDark = document.body.classList.contains('dark-mode');
    const gridColor = isDark ? 'rgba(148,163,184,.15)' : 'rgba(15,23,42,.06)';
    const textColor = isDark ? '#94a3b8' : '#64748b';

    if(dashTrendChart){
        dashTrendChart.data.labels = labels;
        dashTrendChart.data.datasets[0].data = counts;
        dashTrendChart.options.scales.x.ticks.color = textColor;
        dashTrendChart.options.scales.y.ticks.color = textColor;
        dashTrendChart.options.scales.y.grid.color = gridColor;
        dashTrendChart.update();
        return;
    }

    dashTrendChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Kasus',
                data: counts,
                borderColor: '#f97316',
                backgroundColor: 'rgba(249,115,22,.12)',
                fill: true,
                tension: 0.35,
                pointRadius: 4,
                pointBackgroundColor: '#f97316',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { mode: 'index', intersect: false }
            },
            scales: {
                x: {
                    ticks: { color: textColor, font: { size: 10, weight: '700' } },
                    grid: { display: false }
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: textColor, stepSize: 1, font: { size: 10 } },
                    grid: { color: gridColor }
                }
            }
        }
    });
}


/** Deteksi kategori pelanggaran berdasarkan keyword dinamis dari Supabase */
function detectViolationCategories(text){
    // Normalisasi agresif: hapus tanda baca, kurung, angka jam, spasi dobel
    const t = String(text || '')
        .toLowerCase()
        .replace(/[.,;:\/\\|+&()[\]{}'"`~!@#$%^*=?<>]/g, ' ')
        .replace(/\d{1,2}\s*[:.]\s*\d{2}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const matched = [];

    (violationCategories || []).forEach(cat => {
        const keywords = Array.isArray(cat.keywords) ? cat.keywords : [];
        let hit = keywords.some(kw => {
            const k = String(kw || '').toLowerCase().trim();
            if(!k) return false;
            // Frasa multi-kata: harus muncul utuh
            if(k.includes(' ')) return t.includes(k);
            // Kata tunggal: HANYA word-boundary.
            // Jangan pakai t.includes(k) — menyebabkan false positive
            // contoh: keyword "ribut" ikut kena di kata "atribut".
            const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp('\\b' + escaped + '\\b').test(t);
        });

        // Fallback: kategori yang namanya soal keterlambatan
        if(!hit && /terlambat|telat/i.test(String(cat.name || ''))){
            hit = /terlambat|keterlambatan|\btelat\b|ter\s*lambat/i.test(t);
        }

        if(hit) matched.push(cat.name);
    });

    if(matched.length === 0) matched.push('Lainnya');
    return matched;
}


function getGroups(data, filterType){
    const groups = {};

    // Klasifikasi dihitung dari snapshot aturan resmi yang melekat pada tiap catatan.
    if(filterType === 'klasifikasi' || filterType === 'aturan'){
        const currentRules = new Map((violationPointRulesAll || []).map(rule => [String(rule.code), rule]));
        data.forEach(item => {
            const pointItems = getRecordPointItems(item.id);
            if(!pointItems.length){
                groups['Belum Dipetakan'] = (groups['Belum Dipetakan'] || 0) + 1;
                return;
            }
            pointItems.forEach(point => {
                const code = String(point.violation_code || '').trim();
                const currentRule = currentRules.get(code);
                if(filterType === 'aturan'){
                    const label = code ? `${code} — ${currentRule?.name || 'Aturan historis'}` : 'Aturan tidak diketahui';
                    groups[label] = (groups[label] || 0) + 1;
                }else{
                    const severity = String(point.severity_snapshot || currentRule?.severity || '').trim();
                    const label = ['Ringan','Sedang','Berat'].find(x => x.toLowerCase() === severity.toLowerCase()) || 'Belum Dipetakan';
                    groups[label] = (groups[label] || 0) + 1;
                }
            });
        });
        const severityOrder = ['Berat','Sedang','Ringan','Belum Dipetakan'];
        return Object.entries(groups).sort((a,b) => {
            if(filterType === 'klasifikasi') return severityOrder.indexOf(a[0]) - severityOrder.indexOf(b[0]);
            return b[1] - a[1] || a[0].localeCompare(b[0], 'id');
        });
    }

    // ==========================================
    // BERDASARKAN KELAS
    // ==========================================
    if(filterType === 'kelas'){
        data.forEach(item => {
            const k = (item.kelas || 'Tanpa Kelas')
                .toUpperCase()
                .trim();

            groups[k] = (groups[k] || 0) + 1;
        });

        return Object.entries(groups)
            .sort((a,b) => a[0].localeCompare(b[0]));
    }

    // ==========================================
    // BERDASARKAN TINGKAT
    // ==========================================
    if(filterType === 'tingkat'){
        function detectTingkat(kelasRaw) {
            const k = String(kelasRaw || '').toUpperCase().trim();
            if (!k) return null;
            // SMK: XII → XI → X
            if (/(?:^|[^A-Z0-9])XII(?:[^A-Z0-9]|$)/.test(k) || /(?:^|[^0-9])12(?:[^0-9]|$)/.test(k) || k.startsWith('XII')) return 'Kelas XII';
            if (/(?:^|[^A-Z0-9])XI(?:[^A-Z0-9]|$)/.test(k) || /(?:^|[^0-9])11(?:[^0-9]|$)/.test(k) || k.startsWith('XI')) return 'Kelas XI';
            if (/(?:^|[^A-Z0-9])X(?:[^A-Z0-9]|$)/.test(k) || /(?:^|[^0-9])10(?:[^0-9]|$)/.test(k) || /^X[\s.\-]/.test(k) || k === 'X') return 'Kelas X';
            // SMP: VIII → VII → IX (VIII dulu karena mengandung VII)
            if (/(?:^|[^A-Z0-9])VIII(?:[^A-Z0-9]|$)/.test(k) || /(?:^|[^0-9])8(?:[^0-9]|$)/.test(k) || /^8[A-Z.\s]/.test(k) || k.startsWith('VIII')) return 'Kelas 8';
            if (/(?:^|[^A-Z0-9])VII(?:[^A-Z0-9]|$)/.test(k) || /(?:^|[^0-9])7(?:[^0-9]|$)/.test(k) || /^7[A-Z.\s]/.test(k) || k.startsWith('VII')) return 'Kelas 7';
            if (/(?:^|[^A-Z0-9])IX(?:[^A-Z0-9]|$)/.test(k) || /(?:^|[^0-9])9(?:[^0-9]|$)/.test(k) || /^9[A-Z.\s]/.test(k) || k.startsWith('IX')) return 'Kelas 9';
            return null;
        }

        const mode = (typeof schoolMode === 'string') ? schoolMode : 'all';
        if (mode === 'smp') {
            groups['Kelas 7'] = 0; groups['Kelas 8'] = 0; groups['Kelas 9'] = 0;
        } else if (mode === 'smk') {
            groups['Kelas X'] = 0; groups['Kelas XI'] = 0; groups['Kelas XII'] = 0;
        } else {
            groups['Kelas 7'] = 0; groups['Kelas 8'] = 0; groups['Kelas 9'] = 0;
            groups['Kelas X'] = 0; groups['Kelas XI'] = 0; groups['Kelas XII'] = 0;
        }
        groups['Lainnya'] = 0;

        data.forEach(item => {
            const tingkat = detectTingkat(item.kelas);
            if (tingkat && Object.prototype.hasOwnProperty.call(groups, tingkat)) {
                groups[tingkat]++;
            } else if (tingkat && mode === 'all') {
                groups[tingkat] = (groups[tingkat] || 0) + 1;
            } else {
                groups['Lainnya']++;
            }
        });

        Object.keys(groups).forEach(key => { if (groups[key] === 0) delete groups[key]; });

        const order = ['Kelas 7', 'Kelas 8', 'Kelas 9', 'Kelas X', 'Kelas XI', 'Kelas XII', 'Lainnya'];
        return order.filter(k => groups[k] != null).map(k => [k, groups[k]]);
    }

    // ==========================================
    // BERDASARKAN JURUSAN
    // ==========================================
    if(filterType === 'jurusan'){
        data.forEach(item => {
            const j = (item.jurusan || '').trim();
            const k = j ? j.toUpperCase() : 'Tanpa Jurusan';
            groups[k] = (groups[k] || 0) + 1;
        });
        return Object.entries(groups)
            .sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0], 'id'));
    }

    // ==========================================
    // BERDASARKAN MINGGU
    // ==========================================
    if(filterType === 'minggu'){
        const weeklyData = {};
        const monthNames = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agt","Sep","Okt","Nov","Des"];

        // Kalau filter tanggal aktif → label minggu dalam bulan (M1 Sep, M2 Sep)
        // Kalau tidak → minggu ISO tahun (M37 '26)
        const fromDate = document.getElementById('chart-from')?.value || '';
        const toDate = document.getElementById('chart-to')?.value || '';
        const useMonthWeek = !!(fromDate || toDate);

        data.forEach(item => {
            if(!item.tanggal) return;

            const d = parseDateOnly(item.tanggal);
            if (!d || isNaN(d)) return;

            let weekKey;
            let sortKey;

            if(useMonthWeek){
                // Minggu ke-1..5 dalam bulan tersebut
                const weekOfMonth = Math.ceil(d.getDate() / 7);
                const mon = monthNames[d.getMonth()];
                weekKey = `M${weekOfMonth} ${mon}`;
                // sort: tahun-bulan-minggu
                sortKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-W${weekOfMonth}`;
            } else {
                // ISO week of year
                const target = new Date(d.valueOf());
                const dayNr = (d.getDay() + 6) % 7;
                target.setDate(target.getDate() - dayNr + 3);
                const firstThursday = new Date(target.getFullYear(), 0, 4);
                const firstDayNr = (firstThursday.getDay() + 6) % 7;
                firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
                const weekNum = Math.floor((target - firstThursday) / (7 * 86400000)) + 1;
                weekKey = `M${weekNum} '${String(d.getFullYear()).slice(2)}`;
                sortKey = `${d.getFullYear()}-W${String(weekNum).padStart(2,'0')}`;
            }

            if(!weeklyData[weekKey]){
                weeklyData[weekKey] = { count: 0, sortKey };
            }
            weeklyData[weekKey].count += 1;
        });

        return Object.entries(weeklyData)
            .sort((a, b) => a[1].sortKey.localeCompare(b[1].sortKey))
            .map(([label, obj]) => [label, obj.count]);
    }

    // ==========================================
    // BERDASARKAN BULAN
    // ==========================================
    if(filterType === 'bulan'){
        const monthNames = [
            "Jan", "Feb", "Mar", "Apr",
            "Mei", "Jun", "Jul", "Agt",
            "Sep", "Okt", "Nov", "Des"
        ];

        const monthlyData = {};

        data.forEach(item => {
            if(!formatTanggalIndonesia(item.tanggal)) return;

            const parts = item.tanggal.substring(0, 10).split('-');

if(parts.length === 3){
    const year = parts[0];
    const monthIndex = parseInt(parts[1], 10) - 1;

    if(monthIndex >= 0 && monthIndex < 12){
        const key = `${monthNames[monthIndex]} ${year}`;
        monthlyData[key] = (monthlyData[key] || 0) + 1;
    }
}
        });

        return Object.entries(monthlyData);
    }

    // ==========================================
    // PROSES SEMUA DATA PELANGGARAN (jenis)
    // ==========================================

    data.forEach(item => {

        const raw =
            (item.pelanggaran || '').trim();

        if(!raw) return;

        const detected = detectViolationCategories(raw);

        detected.forEach(category => {
            groups[category] = (groups[category] || 0) + 1;
        });
    });

    // ==========================================
    // URUTKAN DARI TERBANYAK
    // ==========================================
    return Object.entries(groups)
        .sort((a,b) => b[1] - a[1]);
}

function updateChart(data = records) {
    const canvas = document.getElementById('pelanggaranChart');
    const filterEl = document.getElementById('chart-filter');

    if (!canvas || typeof Chart === 'undefined') return;

    const filterType = filterEl ? filterEl.value : 'klasifikasi';

    // Filter rentang tanggal (opsional)
    const fromEl = document.getElementById('chart-from');
    const toEl = document.getElementById('chart-to');
    const fromDate = fromEl?.value || '';
    const toDate = toEl?.value || '';
    let filtered = filterBySchoolMode(data || []);
    if(fromDate || toDate){
        filtered = filtered.filter(item => {
            const tgl = item.tanggal ? String(item.tanggal).substring(0, 10) : '';
            if(!tgl) return false;
            if(fromDate && tgl < fromDate) return false;
            if(toDate && tgl > toDate) return false;
            return true;
        });
    }

    // Hapus chart sebelumnya
    if (myChart) {
        myChart.destroy();
        myChart = null;
    }

    const grouped = getGroups(filtered, filterType);

    const labels = grouped.map(item => item[0]);
    const values = grouped.map(item => item[1]);

    const ctx = canvas.getContext('2d');

    // ==========================================
    // WARNA GRAFIK
    // ==========================================

    const colors = [
        '#3B82F6',
        '#EF4444',
        '#10B981',
        '#F59E0B',
        '#8B5CF6',
        '#EC4899',
        '#06B6D4',
        '#F97316',
        '#84CC16',
        '#6366F1',
        '#14B8A6',
        '#E11D48'
    ];

    const borderColors = [
        '#2563EB',
        '#DC2626',
        '#059669',
        '#D97706',
        '#7C3AED',
        '#DB2777',
        '#0891B2',
        '#EA580C',
        '#65A30D',
        '#4F46E5',
        '#0D9488',
        '#BE123C'
    ];

    // ==========================================
    // KHUSUS PER TINGKAT → PIE CHART
    // ==========================================

    if (filterType === 'tingkat') {

        myChart = new Chart(ctx, {
            type: 'pie',

            data: {
                labels: labels,

                datasets: [{
                    data: values,

                    backgroundColor: colors.slice(
                        0,
                        labels.length
                    ),

                    borderColor: '#ffffff',

                    borderWidth: 3,

                    hoverOffset: 12
                }]
            },

            options: {
                responsive: true,
                maintainAspectRatio: false,

                plugins: {

                    legend: {
                        position: 'bottom',

                        labels: {
                            padding: 18,
                            usePointStyle: true,
                            font: {
                                size: 13,
                                weight: 'bold'
                            }
                        }
                    },

                    tooltip: {
                        callbacks: {

                            label: function(context) {

                                const total =
                                    context.dataset.data
                                    .reduce(
                                        (sum, value) =>
                                            sum + value,
                                        0
                                    );

                                const value = context.raw;

                                const percentage =
                                    total > 0
                                    ? ((value / total) * 100)
                                        .toFixed(1)
                                    : 0;

                                return ` ${context.label}: ${value} kasus (${percentage}%)`;
                            }

                        }
                    }
                }
            }
        });

        return;
    }

    // ==========================================
    // JENIS / KELAS → BAR
    // MINGGU / BULAN → LINE
    // ==========================================

    const isTrend =
        filterType === 'minggu' ||
        filterType === 'bulan';

    myChart = new Chart(ctx, {

        type: isTrend ? 'line' : 'bar',

        data: {
            labels: labels,

            datasets: [{
                label:
                    filterType === 'klasifikasi'
                        ? 'Pemetaan per Klasifikasi Resmi'
                        : filterType === 'aturan'
                        ? 'Penggunaan Aturan Resmi'
                        : filterType === 'jenis'
                        ? 'Jumlah Pelanggaran'
                        : filterType === 'kelas'
                        ? 'Pelanggaran per Kelas'
                        : filterType === 'jurusan'
                        ? 'Pelanggaran per Jurusan'
                        : filterType === 'tingkat'
                        ? 'Pelanggaran per Tingkat'
                        : filterType === 'minggu'
                        ? 'Pelanggaran per Minggu'
                        : 'Pelanggaran per Bulan',

                data: values,

                backgroundColor: colors.slice(
                    0,
                    labels.length
                ),

                borderColor: isTrend
                    ? '#3B82F6'
                    : borderColors.slice(
                        0,
                        labels.length
                    ),

                borderWidth: 2,

                borderRadius: isTrend ? 0 : 7,

                tension: isTrend ? 0.35 : 0,

                fill: false
            }]
        },

        options: {

            responsive: true,

            maintainAspectRatio: false,

            plugins: {

                legend: {
                    display: isTrend,

                    position: 'bottom'
                },

                tooltip: {
                    callbacks: {

                        label: function(context) {

                            return ` ${context.raw} kasus`;

                        }

                    }
                }

            },

            scales: {

                x: {
                    ticks: {
                        // Bar kategori: tampilkan SEMUA label (jangan di-skip)
                        autoSkip: isTrend,
                        maxTicksLimit: isTrend ? 8 : 20,
                        maxRotation: isTrend ? 0 : 40,
                        minRotation: 0,
                        font: { size: 10 },
                        padding: 4,
                        callback: function(value) {
                            const label = this.getLabelForValue(value);
                            if(!label) return '';
                            // Potong label terlalu panjang biar tetap kebaca
                            const s = String(label);
                            return s.length > 14 ? s.slice(0, 12) + '…' : s;
                        }
                    },
                    grid: {
                        display: true,
                        drawBorder: false
                    }
                },

                y: {
                    beginAtZero: true,
                    ticks: {
                        precision: 0,
                        stepSize: 1,
                        font: { size: 11 }
                    },
                    grid: {
                        drawBorder: false
                    }
                }

            },

            layout: {
                padding: { left: 4, right: 8, top: 8, bottom: isTrend ? 4 : 12 }
            }

        }

    });
}
function normTA(value){
    return String(value || '').trim().replace(/-/g, '/').toLowerCase();
}

function getStudentKey(nama, kelas, tahunAjaran){
    if(tahunAjaran){
        return `${normalizeName(nama)}__ta:${normTA(tahunAjaran)}`;
    }
    return `${normalizeName(nama)}__${normalizeName(kelas)}`;
}

function getAvailableTahunAjaranList(){
    const set = new Set();
    filterBySchoolMode(records).forEach(item => {
        const ta = String(item.tahun_ajaran || '').trim();
        if(ta) set.add(ta);
    });
    const { tahunAjaran: defaultTA } = getDefaultTahunAjaranSemester();
    const list = [...set].sort((a,b) => b.localeCompare(a, 'id'));
    if(!list.includes(defaultTA)) list.unshift(defaultTA);
    if(!list.length) list.push(defaultTA);
    return list;
}

function populateReportTahunAjaranSelect(){
    const sel = document.getElementById('report-tahun-ajaran');
    if(!sel) return;
    const list = getAvailableTahunAjaranList();
    const { tahunAjaran: defaultTA } = getDefaultTahunAjaranSemester();
    const prev = sel.value;
    sel.innerHTML = list.map(ta =>
        `<option value="${escapeAttr(ta)}">${escapeHtml(ta)}</option>`
    ).join('');
    if(prev && list.some(t => normTA(t) === normTA(prev))){
        sel.value = list.find(t => normTA(t) === normTA(prev)) || defaultTA;
    } else {
        sel.value = list.find(t => normTA(t) === normTA(defaultTA)) || list[0] || defaultTA;
    }
}

function getThreeStrikeStudents(tahunAjaran){
    const groups = {};
    const targetTA = normTA(
        tahunAjaran ||
        document.getElementById('report-tahun-ajaran')?.value ||
        getDefaultTahunAjaranSemester().tahunAjaran
    );

    // Hitung ambang 3x hanya pada TA yang dipilih, tetapi pelanggaran Berat
    // tetap menjadi alasan tindak lanjut karena masa akumulasinya sampai lulus.
    filterBySchoolMode(records).forEach(item => {
        const nama = String(item.nama || '').trim();
        const kelas = String(item.kelas || '').trim();
        if(!nama) return;
        const key = normalizeName(nama);
        if(!groups[key]){
            groups[key] = {
                nama, kelas:kelas || '-', kelasList:[], records:[], allRecords:[], heavyRecords:[],
                countForTA:0, tahun_ajaran:tahunAjaran || getDefaultTahunAjaranSemester().tahunAjaran
            };
        }
        const g = groups[key];
        g.allRecords.push(item);
        if(normTA(item.tahun_ajaran) === targetTA){
            g.records.push(item);
            g.countForTA++;
        }
        const kelasNow = String(item.kelas || '').trim();
        if(kelasNow && !g.kelasList.some(k => normalizeName(k) === normalizeName(kelasNow))) g.kelasList.push(kelasNow);
        if(kelasNow) g.kelas = kelasNow;
        if(getRecordPointItems(item.id).some(point => getOfficialPointSeverity(point).toLowerCase() === 'berat')){
            g.heavyRecords.push(item);
        }
    });

    return Object.values(groups)
        .map(g => {
            const latest = [...g.allRecords].sort((a,b) =>
                String(b.tanggal||'').localeCompare(String(a.tanggal||'')) || Number(b.id||0) - Number(a.id||0)
            )[0];
            g.kelas = String(latest?.kelas || g.kelas || '-').trim() || '-';
            g.hasHeavyViolation = g.heavyRecords.length > 0;
            // Untuk riwayat laporan, tampilkan catatan TA terpilih serta pelanggaran Berat historis.
            const relevant = [...g.records, ...g.heavyRecords];
            const seen = new Set();
            g.reportRecords = relevant.filter(row => {
                const id = String(row.id);
                if(seen.has(id)) return false;
                seen.add(id);
                return true;
            });
            g.reportReasons = [];
            if(g.countForTA >= 3) g.reportReasons.push('3x atau lebih pada TA terpilih');
            if(g.hasHeavyViolation) g.reportReasons.push('Pelanggaran Berat sampai lulus');
            return g;
        })
        .filter(g => g.countForTA >= 3 || g.hasHeavyViolation)
        .sort((a,b) => Number(b.hasHeavyViolation) - Number(a.hasHeavyViolation) || b.countForTA - a.countForTA || a.nama.localeCompare(b.nama, 'id'));
}

function parseBuktiUrls(value){
    if(Array.isArray(value)) return value.filter(u => typeof u === 'string' && u.trim());
    if(typeof value === 'string' && value.trim()){
        try {
            const parsed = JSON.parse(value);
            if(Array.isArray(parsed)) return parsed.filter(u => typeof u === 'string' && u.trim());
        } catch(e) {}
        return [value.trim()];
    }
    return [];
}

function getThreeStrikeFollowUp(g){
    const candidates = [];
    const ta = g.tahun_ajaran ||
        document.getElementById('report-tahun-ajaran')?.value ||
        getDefaultTahunAjaranSemester().tahunAjaran;

    if(ta){
        const taKey = getStudentKey(g.nama, g.kelas, ta);
        const taValue = followUpMap[taKey];
        if(taValue && typeof taValue === 'object'){
            candidates.push({key: taKey, value: taValue});
        }
    }

    const kelasCandidates = [...new Set([
        g.kelas,
        ...(g.kelasList || []),
        ...g.records.map(r => String(r.kelas || '').trim()).filter(Boolean)
    ])];

    for(const kelas of kelasCandidates){
        const key = getStudentKey(g.nama, kelas);
        const value = followUpMap[key];
        if(value && typeof value === 'object'){
            candidates.push({key, value});
        }
    }

    candidates.sort((a,b) =>
        String(b.value.updated_at || '').localeCompare(String(a.value.updated_at || ''))
    );

    const key = candidates[0]?.key || getStudentKey(g.nama, g.kelas, ta);
    return {key, follow:getFollowUp(key)};
}

function getFollowUp(key){
    const value = followUpMap[key];
    if(!value || typeof value !== 'object') {
        return {status:'Belum Ditindak', tanggal:'', oleh:'', catatan:'', updated_at:'', bukti_urls:[]};
    }
    return {
        status: value.status || 'Belum Ditindak',
        tanggal: value.tanggal || '',
        oleh: value.oleh || '',
        catatan: value.catatan || '',
        updated_at: value.updated_at || '',
        bukti_urls: parseBuktiUrls(value.bukti_urls)
    };
}

async function loadFollowUpsFromSupabase(){
    try{
        const { data, error } = await _supabase.from('tindak_lanjut').select('*');
        if(error){
            followUpCloudReady = false;
            // Bila Supabase gagal dibaca, jangan tampilkan catatan lama dari browser.
            followUpMap = {};
            try { localStorage.removeItem('smpgelora_tindak_lanjut'); } catch (_) {}
            console.error('Gagal membaca public.tindak_lanjut; cache lokal lama dibuang:', error.message);
            return;
        }

        followUpCloudReady = true;
        const cloudMap = {};
        (data || []).forEach(row => {
            if(row.student_key){
                cloudMap[row.student_key] = {
                    status: row.status || 'Belum Ditindak',
                    tanggal: row.tanggal || '',
                    oleh: row.oleh || '',
                    catatan: row.catatan || '',
                    updated_at: row.updated_at || '',
                    bukti_urls: parseBuktiUrls(row.bukti_urls)
                };
            }
        });

        await Promise.all(Object.values(cloudMap).map(async value => {
            value.bukti_urls = await resolveStorageUrlList(value.bukti_urls);
        }));

        // Supabase adalah sumber data utama. Jangan gabungkan cache lokal lama:
        // cache dapat menghidupkan kembali catatan tindak lanjut yang sudah dihapus.
        // Hanya data yang benar-benar ada di tabel Supabase yang ditampilkan.
        followUpMap = cloudMap;
        localStorage.setItem('smpgelora_tindak_lanjut', JSON.stringify(cloudMap));

    }catch(err){
        followUpCloudReady = false;
        // Fail closed: catatan lama tidak boleh muncul saat data cloud tidak terverifikasi.
        followUpMap = {};
        try { localStorage.removeItem('smpgelora_tindak_lanjut'); } catch (_) {}
        console.error('Gagal memuat tindak lanjut dari Supabase; cache lokal lama dibuang:', err);
    }
}

function normalizeFollowUpStatus(status){
    // Label UI boleh bernomor, tetapi nilai database memakai status tanpa prefix angka.
    return String(status || 'Belum Ditindak').trim().replace(/^\s*[1-5]\.\s*/, '');
}

async function saveFollowUp(key, data, nama='', kelas=''){
    // Hardening P1: setiap perubahan mendapat timestamp agar konflik lokal/cloud
    // dapat diselesaikan deterministik.
    const buktiUrls = parseBuktiUrls(data.bukti_urls);
    const buktiPaths = storagePathsFromValues(buktiUrls);
    const normalized = {
        status: normalizeFollowUpStatus(data.status),
        tanggal: data.tanggal || '',
        oleh: data.oleh || '',
        catatan: data.catatan || '',
        updated_at: new Date().toISOString(),
        bukti_urls: buktiUrls
    };

    followUpMap[key] = normalized;
    localStorage.setItem('smpgelora_tindak_lanjut', JSON.stringify(followUpMap));

    try{
        followUpSyncLastError = '';
        const payload = {
            student_key: key,
            nama: nama || key.split('__')[0] || '-',
            kelas: kelas || (key.includes('__ta:') ? '-' : (key.split('__')[1] || '-')),
            status: normalized.status,
            tanggal: normalized.tanggal || null,
            oleh: normalized.oleh || null,
            catatan: normalized.catatan || null,
            updated_at: normalized.updated_at,
            bukti_urls: buktiPaths
        };
        const { error } = await _supabase.from('tindak_lanjut').upsert([payload], {onConflict:'student_key'});
        if(error) throw error;
        followUpCloudReady = true;
        followUpSyncLastError = '';
        return true;
    }catch(err){
        followUpCloudReady = false;
        followUpSyncLastError = String(err?.message || err || 'Error tidak diketahui');
        if(err?.code) followUpSyncLastError += ` (kode: ${err.code})`;
        if(err?.details) followUpSyncLastError += `\nDetail: ${err.details}`;
        if(err?.hint) followUpSyncLastError += `\nPetunjuk: ${err.hint}`;
        console.warn('Status tersimpan lokal, tetapi gagal disinkronkan ke Supabase:', err);
        return false;
    }
}

function statusBadgeHtml(status){
    const map = {
        'Belum Ditindak': ['#64748b','⚪'],
        'Peringatan lisan dan pembinaan secara langsung': ['#2563eb','🔵'],
        'Peringatan tertulis melalui Form Pelanggaran Siswa': ['#0d9488','🟦'],
        'Pemanggilan orang tua/wali peserta didik': ['#d97706','🟠'],
        'Skorsing tidak boleh mengikuti pelajaran': ['#ea580c','🟠'],
        'Dikembalikan/dikeluarkan dari sekolah kepada orang tua/wali secara tidak hormat': ['#dc2626','🔴'],
        // Nilai lama tetap dikenali agar catatan historis tidak rusak.
        'Sudah Ditindak Wali Kelas': ['#f59e0b','🟠'],
        'Sudah Ditindak BK': ['#7c3aed','🟣'],
        'Dilaporkan ke Tim Inti 1': ['#2563eb','🔵'],
        'Selesai / Sudah Ditangani': ['#21a366','🟢']
    };
    const [bg, icon] = map[status] || map['Belum Ditindak'];
    return `<span class="badge" style="background:${bg};display:inline-block">${icon} ${escapeHtml(status)}</span>`;
}

async function uploadBuktiTindakanFiles(fileList){
    const files = Array.from(fileList || []).filter(f => f && f.type && f.type.startsWith('image/'));
    if(!files.length) return [];
    const urls = [];
    for(const file of files){
        const compressed = await compressImage(file, 1000, 0.72);
        const fileName = `bukti-tindak/${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
        const { error: uploadError } = await _supabase.storage
            .from('foto-pelanggaran')
            .upload(fileName, compressed);
        if(uploadError) throw uploadError;
        const signedUrl = await createSignedStorageUrl(fileName);
        if(signedUrl) urls.push(signedUrl);
    }
    return urls;
}

async function updateFollowUp(nama, kelas){
    if(!currentUser){
        return Swal.fire({ icon:'warning', title:'Akses Admin', text:'Login terlebih dahulu untuk memperbarui status tindak lanjut.', confirmButtonColor:'#f97316' });
    }
    const ta = document.getElementById('report-tahun-ajaran')?.value ||
        getDefaultTahunAjaranSemester().tahunAjaran;
    const key = getStudentKey(nama, kelas, ta);
    const gProxy = { nama, kelas, kelasList: [kelas], records: [], tahun_ajaran: ta };
    const { follow: current } = getThreeStrikeFollowUp(gProxy);
    let keptBukti = [...(current.bukti_urls || [])];

    const existingHtml = keptBukti.length
        ? `<div id="swal-bukti-existing" style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px;">
            ${keptBukti.map((url, idx) => `
                <div data-bukti-idx="${idx}" style="position:relative;width:72px;height:72px;">
                    <img src="${escapeAttr(url)}" alt="Bukti" onclick="openPhotoLightbox('${escapeAttr(url)}', '${escapeAttr(nama)}')"
                        style="width:72px;height:72px;object-fit:cover;border-radius:10px;border:1px solid var(--border);cursor:zoom-in;">
                    <button type="button" data-remove-bukti="${idx}"
                        style="position:absolute;top:-6px;right:-6px;width:22px;height:22px;border:0;border-radius:50%;background:#e53935;color:#fff;font-size:12px;font-weight:800;cursor:pointer;line-height:22px;">×</button>
                </div>
            `).join('')}
           </div>`
        : `<p id="swal-bukti-empty" style="font-size:11px;color:var(--muted);margin:0 0 8px;">Belum ada bukti terunggah.</p>`;

    const { value: formValues } = await Swal.fire({
        title: `Tindak Lanjut — ${escapeHtml(nama)}`,
        html: `
            <div style="text-align:left">
                <p style="font-size:11px;color:var(--muted);margin:0 0 10px;">Tahun Ajaran: <strong>${escapeHtml(ta)}</strong></p>
                <label style="font-weight:700;font-size:12px;display:block;margin-bottom:5px">Tahapan Sanksi (sesuai tata tertib sekolah)</label>
                <select id="swal-follow-status" class="swal2-input" style="width:100%;height:auto;min-height:48px;white-space:normal;line-height:1.4;padding:10px 12px;margin:0 0 10px">
                    <option value="Belum Ditindak" ${current.status==='Belum Ditindak'?'selected':''}>Belum Ditindak</option>
                    <option value="Peringatan lisan dan pembinaan secara langsung" ${normalizeFollowUpStatus(current.status)==='Peringatan lisan dan pembinaan secara langsung'?'selected':''}>1. Peringatan lisan dan pembinaan secara langsung</option>
                    <option value="Peringatan tertulis melalui Form Pelanggaran Siswa" ${normalizeFollowUpStatus(current.status)==='Peringatan tertulis melalui Form Pelanggaran Siswa'?'selected':''}>2. Peringatan tertulis melalui Form Pelanggaran Siswa</option>
                    <option value="Pemanggilan orang tua/wali peserta didik" ${normalizeFollowUpStatus(current.status)==='Pemanggilan orang tua/wali peserta didik'?'selected':''}>3. Pemanggilan orang tua/wali peserta didik</option>
                    <option value="Skorsing tidak boleh mengikuti pelajaran" ${normalizeFollowUpStatus(current.status)==='Skorsing tidak boleh mengikuti pelajaran'?'selected':''}>4. Skorsing tidak boleh mengikuti pelajaran</option>
                    <option value="Dikembalikan/dikeluarkan dari sekolah kepada orang tua/wali secara tidak hormat" ${normalizeFollowUpStatus(current.status)==='Dikembalikan/dikeluarkan dari sekolah kepada orang tua/wali secara tidak hormat'?'selected':''}>5. Dikembalikan/dikeluarkan dari sekolah kepada orang tua/wali secara tidak hormat</option>
                    ${['Sudah Ditindak Wali Kelas','Sudah Ditindak BK','Dilaporkan ke Tim Inti 1','Selesai / Sudah Ditangani'].includes(current.status) ? `<option value="${escapeAttr(current.status)}" selected>Status lama: ${escapeHtml(current.status)} (pilih tahapan baru)</option>` : ''}
                </select>
                <p style="font-size:11px;color:var(--muted);margin:-4px 0 10px;line-height:1.45">Urutan tahapan mengikuti PDF Tata Tertib. Pilih tahap yang benar-benar telah diberikan kepada siswa.</p>
                <label style="font-weight:700;font-size:12px;display:block;margin-bottom:5px">Tanggal Tindakan</label>
                <input id="swal-follow-date" type="date" class="swal2-input" value="${escapeAttr(current.tanggal || getLocalDateISO())}" style="width:100%;margin:0 0 10px">
                <label style="font-weight:700;font-size:12px;display:block;margin-bottom:5px">Ditindak oleh</label>
                <input id="swal-follow-by" class="swal2-input" value="${escapeAttr(current.oleh || currentUser.nama || '')}" placeholder="Nama guru/petugas" style="width:100%;margin:0 0 10px">
                <label style="font-weight:700;font-size:12px;display:block;margin-bottom:5px">Catatan</label>
                <textarea id="swal-follow-note" class="swal2-textarea" placeholder="Catatan tindak lanjut" style="width:100%;margin:0 0 10px">${escapeHtml(current.catatan || '')}</textarea>
                <label style="font-weight:700;font-size:12px;display:block;margin-bottom:5px">Bukti Tindakan (gambar, bisa lebih dari 1)</label>
                ${existingHtml}
                <input id="swal-follow-bukti" type="file" accept="image/*" multiple class="swal2-file" style="width:100%;font-size:12px;">
                <p style="font-size:11px;color:var(--muted);margin:6px 0 0;">Gambar otomatis dikompres. Boleh upload beberapa surat/foto sekaligus.</p>
            </div>`,
        showCancelButton:true,
        confirmButtonText:'💾 Simpan Status',
        cancelButtonText:'Batal',
        confirmButtonColor:'#21a366',
        didOpen: () => {
            const box = document.getElementById('swal-bukti-existing');
            if(!box) return;
            box.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-remove-bukti]');
                if(!btn) return;
                const idx = Number(btn.getAttribute('data-remove-bukti'));
                if(Number.isNaN(idx)) return;
                keptBukti = keptBukti.filter((_, i) => i !== idx);
                const card = btn.closest('[data-bukti-idx]');
                if(card) card.remove();
                if(!keptBukti.length && !document.getElementById('swal-bukti-empty')){
                    const p = document.createElement('p');
                    p.id = 'swal-bukti-empty';
                    p.style.cssText = 'font-size:11px;color:var(--muted);margin:0 0 8px;';
                    p.textContent = 'Belum ada bukti terunggah.';
                    box.parentNode.insertBefore(p, box);
                }
            });
        },
        preConfirm: async () => {
            const status = document.getElementById('swal-follow-status').value;
            const tanggal = document.getElementById('swal-follow-date').value;
            const oleh = document.getElementById('swal-follow-by').value.trim();
            const catatan = document.getElementById('swal-follow-note').value.trim();
            const fileInput = document.getElementById('swal-follow-bukti');
            let newUrls = [];
            try {
                if(fileInput?.files?.length){
                    Swal.showLoading();
                    newUrls = await uploadBuktiTindakanFiles(fileInput.files);
                }
            } catch(err){
                Swal.showValidationMessage('Gagal mengunggah bukti: ' + (err.message || err));
                return false;
            }
            return {
                status, tanggal, oleh, catatan,
                bukti_urls: [...keptBukti, ...newUrls]
            };
        }
    });
    if(formValues){
        const synced = await saveFollowUp(key, formValues, nama, kelas);
        const nBukti = (formValues.bukti_urls || []).length;
        await catatLog('TINDAK_LANJUT', `Memperbarui tindak lanjut ${nama} (${kelas}) TA ${ta}: ${formValues.status}${formValues.catatan ? ' - ' + formValues.catatan : ''}${nBukti ? ` [${nBukti} bukti]` : ''}`);
        renderThreeStrikeReport();
        updateStats();
        if(synced){
            Swal.fire({
                icon:'success',
                title:'Status tersimpan ke Supabase',
                text:`Status ${nama} berhasil disimpan${nBukti ? ` (${nBukti} bukti)` : ''} dan tersinkron ke database.`,
                timer:2000,
                showConfirmButton:false
            });
        }else{
            Swal.fire({
                icon:'warning',
                title:'Tersimpan lokal — belum tersinkron',
                text:`Perubahan untuk ${nama} masih tersimpan di perangkat ini, tetapi belum masuk Supabase. Jangan hapus data browser.\n\nPenyebab dari Supabase: ${followUpSyncLastError || 'Tidak ada detail error yang diterima.'}\n\nKirim detail error ini untuk menentukan perbaikan yang tepat.`,
                confirmButtonText:'Mengerti',
                confirmButtonColor:'#f97316'
            });
        }
    }
}

let reportFollowUpDelegationReady = false;

function ensureReportFollowUpDelegation(){
    if(reportFollowUpDelegationReady) return;
    const box = document.getElementById('report-3x-list');
    if(!box) return;
    reportFollowUpDelegationReady = true;
    box.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action="follow-up"]');
        if(!button || !box.contains(button)) return;
        event.preventDefault();
        event.stopPropagation();
        const nama = button.dataset.nama || '';
        const kelas = button.dataset.kelas || '';
        if(!nama || !kelas) return;
        Promise.resolve(updateFollowUp(nama, kelas)).catch(err => {
            console.error('Gagal membuka Tindak Lanjut:', err);
            if(window.Swal) Swal.fire({icon:'error', title:'Tindak Lanjut', text: err?.message || 'Gagal membuka form tindak lanjut.'});
        });
    });
}

function renderThreeStrikeReport(){
    const box = document.getElementById('report-3x-list');
    if(!box) return;
    ensureReportFollowUpDelegation();
    populateReportTahunAjaranSelect();
    const ta = document.getElementById('report-tahun-ajaran')?.value ||
        getDefaultTahunAjaranSemester().tahunAjaran;
    const keyword = (document.getElementById('report-search')?.value || '').toLowerCase().trim();
    const students = getThreeStrikeStudents(ta).filter(g => {
        if(!keyword) return true;
        const nama = (g.nama || '').toLowerCase();
        const kelas = (g.kelas || '').toLowerCase();
        const jurusan = (g.allRecords || g.records || []).map(r => (r.jurusan || '').toLowerCase()).join(' ');
        return nama.includes(keyword) || kelas.includes(keyword) || jurusan.includes(keyword);
    });
    if(!students.length){
        box.innerHTML = `<div class="empty">Belum ada siswa yang memenuhi kriteria tindak lanjut pada TA ${escapeHtml(ta)}.</div>`;
        return;
    }
    box.innerHTML = students.map(g => {
        const { key: followKey, follow } = getThreeStrikeFollowUp(g);
        const hasSavedFollowUp = Object.prototype.hasOwnProperty.call(followUpMap, followKey);
        const latest = [...(g.reportRecords || g.records)].sort((a,b)=>String(b.tanggal||'').localeCompare(String(a.tanggal||''))).slice(0,3);
        const riwayat = latest.map((r,i)=>`${i+1}. ${escapeHtml(r.pelanggaran||'-')} — ${escapeHtml(formatTanggalIndonesia(r.tanggal)||'-')}`).join('<br>');
        const buktiUrls = parseBuktiUrls(follow.bukti_urls);
        const buktiHtml = buktiUrls.length
            ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">
                ${buktiUrls.map(url =>
                    `<img src="${escapeAttr(url)}" alt="Bukti tindakan" onclick="openPhotoLightbox('${escapeAttr(url)}')"
                        style="width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid var(--border);cursor:zoom-in;">`
                ).join('')}
               </div>`
            : '';
        return `<div class="record" style="grid-template-columns:1fr;">
            <div class="record-main">
                <div class="record-name">${escapeHtml(g.nama)}</div>
                <div class="record-meta">🏫 Kelas ${escapeHtml(g.kelas)} · <strong>${g.countForTA}x pada TA ${escapeHtml(ta)}</strong>${g.hasHeavyViolation ? ` · ${g.heavyRecords.length} catatan Berat historis` : ''}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${g.reportReasons.map(reason => `<span class="report-criteria-badge">${escapeHtml(reason)}</span>`).join('')}</div>
                <div style="margin-top:9px">${statusBadgeHtml(follow.status)}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.55">${riwayat}</div>
                ${follow.tanggal || follow.oleh || follow.catatan || buktiUrls.length ? `<div style="margin-top:9px;padding:9px;border-radius:10px;background:var(--bg);font-size:11px;line-height:1.5"><strong>Tindak lanjut:</strong> ${follow.tanggal ? escapeHtml(formatTanggalIndonesia(follow.tanggal)) : '-'}${follow.oleh ? ` · ${escapeHtml(follow.oleh)}` : ''}${follow.catatan ? `<br>${escapeHtml(follow.catatan)}` : ''}${buktiHtml}</div>` : ''}
            </div>
            <div class="actions">
                <button type="button" class="edit-btn" data-action="follow-up" data-nama="${escapeAttr(g.nama)}" data-kelas="${escapeAttr(g.kelas)}">📝 Tindak Lanjut</button>
                <button class="print-btn" onclick="cetakSuratPanggilan('${escapeAttr(g.nama)}','${escapeAttr(g.kelas)}')">🖨️ Cetak</button>
                <button class="notify-btn" onclick="kirimWhatsAppManual('${escapeAttr(g.nama)}','${escapeAttr(g.kelas)}')">💬 WA Wali</button>
            </div>
        </div>`;
    }).join('');
}

async function loadViolationPointItems(){
    violationPointItemsByRecord = {};
    violationPointItemsLoaded = false;
    violationPointItemsError = null;
    try {
        const pageSize = 1000;
        let from = 0;
        const allItems = [];
        while (true) {
            const { data, error } = await _supabase
                .from('pelanggaran_point_items')
                .select('id,pelanggaran_id,violation_code,points_snapshot,severity_snapshot,accumulation_scope_snapshot')
                .order('id', { ascending: true })
                .range(from, from + pageSize - 1);
            if (error) throw error;
            const chunk = Array.isArray(data) ? data : [];
            allItems.push(...chunk);
            if (chunk.length < pageSize) break;
            from += pageSize;
        }
        allItems.forEach(row => {
            const key = String(row.pelanggaran_id ?? '');
            if (!key) return;
            if (!violationPointItemsByRecord[key]) violationPointItemsByRecord[key] = [];
            violationPointItemsByRecord[key].push(row);
        });
        violationPointItemsLoaded = true;
    } catch (error) {
        violationPointItemsError = error;
        violationPointItemsLoaded = false;
        console.warn('Snapshot poin belum dapat dimuat; kartu tidak akan menganggap poin sebagai nol:', error);
    }
}

function getRecordPointItems(recordId){
    return violationPointItemsByRecord[String(recordId ?? '')] || [];
}

function getOfficialPointSeverity(point){
    const snapshot = String(point?.severity_snapshot || '').trim();
    if(snapshot) return snapshot;
    const code = String(point?.violation_code || '').trim();
    const rule = (violationPointRulesAll || []).find(item => String(item.code) === code);
    return String(rule?.severity || '').trim();
}

function getCurrentAccumulationTahunAjaran(){
    // Masa berlaku Ringan mengikuti tahun ajaran terbaru yang tercatat pada
    // jenjang aktif, bukan tahun ajaran dari kartu/riwayat lama yang sedang dibuka.
    const rows = filterBySchoolMode(records).filter(row => String(row.tahun_ajaran || '').trim());
    rows.sort((a, b) => {
        const da = String(a.tanggal || '').slice(0, 10);
        const db = String(b.tanggal || '').slice(0, 10);
        return db.localeCompare(da) || Number(b.id || 0) - Number(a.id || 0);
    });
    return String(rows[0]?.tahun_ajaran || document.getElementById('tahun_ajaran')?.value || '').trim();
}

function getStudentAccumulatedPointSummary(item){
    if (!violationPointItemsLoaded) return { loaded:false, current:null, ringan:0, sedang:0, berat:0, missing:0, tahunAjaranRingan:'' };
    const studentName = normalizeName(item?.nama);
    const studentRecords = filterBySchoolMode(records).filter(row => normalizeName(row.nama) === studentName);
    const targetTA = normTA(getCurrentAccumulationTahunAjaran());
    const result = { loaded:true, current:0, ringan:0, sedang:0, berat:0, missing:0, tahunAjaranRingan:getCurrentAccumulationTahunAjaran() };
    studentRecords.forEach(row => {
        const items = getRecordPointItems(row.id);
        if (!items.length) {
            result.missing++;
            return;
        }
        items.forEach(point => {
            const points = Number(point.points_snapshot || 0);
            const severity = String(point.severity_snapshot || '').trim().toLowerCase();
            const scope = String(point.accumulation_scope_snapshot || '').trim().toLowerCase();
            if (String(row.id) === String(item.id)) result.current += points;
            if (severity === 'ringan' && scope === 'school_year' && targetTA && normTA(row.tahun_ajaran) === targetTA) {
                result.ringan += points;
            } else if (severity === 'sedang' && scope === 'all_school_years') {
                result.sedang += points;
            } else if (severity === 'berat' && scope === 'until_graduation') {
                result.berat += points;
            }
        });
    });
    return result;
}

function renderRecordPointSummary(item){
    const summary = getStudentAccumulatedPointSummary(item);
    if (!summary.loaded) {
        return '<div class="record-points record-points-unavailable"><span class="record-points-label">Akumulasi poin</span><strong>Belum dapat dimuat</strong></div>';
    }
    const currentItems = getRecordPointItems(item.id);
    const currentText = currentItems.length
        ? `<span class="record-current-points">Pelanggaran ini <strong>+${summary.current} poin</strong></span>`
        : '<span class="record-current-points record-points-warning">Pelanggaran ini <strong>belum terpetakan</strong></span>';
    const incomplete = summary.missing
        ? `<div class="record-points-warning record-points-note">⚠ ${summary.missing} catatan belum dipetakan · total belum lengkap</div>`
        : '';
    return `<section class="record-points" aria-label="Ringkasan poin siswa">
        <div class="record-points-heading"><span class="record-points-label">RINGKASAN POIN SISWA</span>${currentText}</div>
        <div class="record-points-breakdown">
            <div class="point-card point-light" title="Akumulasi ringan pada tahun ajaran berjalan"><span>RINGAN</span><strong>${summary.ringan}</strong><small>Tahun ajaran ini</small></div>
            <div class="point-card point-medium" title="Akumulasi sedang lintas tahun ajaran"><span>SEDANG</span><strong>${summary.sedang}</strong><small>Lintas tahun ajaran</small></div>
            <div class="point-card point-heavy" title="Akumulasi berat sampai siswa lulus"><span>BERAT</span><strong>${summary.berat}</strong><small>Sampai lulus</small></div>
        </div>${incomplete}
    </section>`;
}

function renderRecent(){
    const box = document.getElementById('recent-list');
    if(!box)return;
    const latest = [...filterBySchoolMode(records)].sort((a, b) => {
        const da = String(a.tanggal || '').substring(0, 10);
        const db = String(b.tanggal || '').substring(0, 10);
        return db.localeCompare(da) || Number(b.id || 0) - Number(a.id || 0);
    }).slice(0, 6);
    if(!latest.length){
        box.innerHTML = '<div class="empty">Belum ada data pelanggaran.</div>';
        return;
    }
    box.innerHTML = latest.map(item => recordCard(item)).join('');
}

function recordCard(item){
    const photo = item.foto_url
        ? `<img class="record-photo" src="${escapeAttr(item.foto_url)}" alt="Foto bukti" onclick="openPhotoLightboxById(${JSON.stringify(item.id)})">`
        : `<div class="record-photo" style="display:flex;align-items:center;justify-content:center;background:var(--border)">📷</div>`;

    const actions = currentUser ? `
        <div class="actions">
            <button class="notify-btn" onclick="kirimWhatsAppManual('${escapeAttr(item.nama)}', '${escapeAttr(item.kelas)}')">💬 Beritahu Wali</button>
            <button class="print-btn" onclick="cetakSuratPanggilan('${escapeAttr(item.nama)}', '${escapeAttr(item.kelas)}')">🖨️ Cetak</button>
            <button class="edit-btn" onclick="editData(${item.id})">✏️ Edit</button>
            <button class="delete-btn" onclick="hapusData(${item.id})">🗑 Hapus</button>
        </div>` : '';

    return `<div class="record">
        <div class="record-main">
            <div class="record-date">📅 ${escapeHtml(formatTanggalIndonesia(item.tanggal)||'-')}</div>
            <div class="record-name">${escapeHtml(item.nama||'-')}</div>
            <div class="record-meta">🏫 Kelas ${escapeHtml(item.kelas||'-')}${item.jurusan ? ' · ' + escapeHtml(item.jurusan) : ''}${item.semester ? ' · ' + escapeHtml(item.semester) : ''}</div>
            <div class="record-violation">⚠️ ${escapeHtml(item.pelanggaran||'-')}</div>
            ${renderRecordPointSummary(item)}
        </div>
        ${photo}
        ${actions}
    </div>`;
}

function renderTable(){
    const mobile = document.getElementById('record-list');
    const tbody = document.getElementById('table-body');
    const pageInfo = document.getElementById('page-info');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');

    const totalPages = Math.ceil(filteredRecordsCache.length / rowsPerPage) || 1;
    if(currentPage > totalPages) currentPage = totalPages;
    if(currentPage < 1) currentPage = 1;

    const start = (currentPage - 1) * rowsPerPage;
    const paginatedItems = filteredRecordsCache.slice(start, start + rowsPerPage);

    if(mobile){
        mobile.innerHTML = paginatedItems.length ? paginatedItems.map(recordCard).join('') : '<div class="empty">Data tidak ditemukan.</div>';
    }

    if(tbody){
        tbody.innerHTML = '';
        const showJurusan = schoolMode !== 'smp';
        const colCount = showJurusan ? 8 : 7;
        if(!paginatedItems.length){
            tbody.innerHTML = `<tr><td colspan="${colCount}">Data tidak ditemukan</td></tr>`;
        } else {
            paginatedItems.forEach((item, index) => {
                const tr = document.createElement('tr');
                const absoluteNo = start + index + 1;
                const jurusanTd = showJurusan
                    ? `<td>${escapeHtml(item.jurusan||'-')}</td>`
                    : '';
                tr.innerHTML = `
                    <td>${absoluteNo}</td>
                    <td>${escapeHtml(formatTanggalIndonesia(item.tanggal)||'-')}</td>
                    <td>${escapeHtml(item.nama||'-')}</td>
                    <td>${escapeHtml(item.kelas||'-')}</td>
                    ${jurusanTd}
                    <td>${escapeHtml(item.pelanggaran||'-')}</td>
                    <td>${item.foto_url ? `<img src="${escapeAttr(item.foto_url)}" alt="Foto bukti" onclick="openPhotoLightboxById(${JSON.stringify(item.id)})">` : '-'}</td>
                    <td>${currentUser ? `
                        <button class="notify-btn" onclick="kirimWhatsAppManual('${escapeAttr(item.nama)}', '${escapeAttr(item.kelas)}')">💬 WA Wali</button>
                        <button class="print-btn" onclick="cetakSuratPanggilan('${escapeAttr(item.nama)}', '${escapeAttr(item.kelas)}')">Cetak</button>
                        <button class="edit-btn" onclick="editData(${item.id})">Edit</button>
                        <button class="delete-btn" onclick="hapusData(${item.id})">Hapus</button>
                    ` : '-'}</td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    if(pageInfo) pageInfo.textContent = `Halaman ${currentPage} dari ${totalPages}`;
    if(prevBtn) prevBtn.disabled = currentPage === 1;
    if(nextBtn) nextBtn.disabled = currentPage === totalPages || totalPages === 0;
}

function changePage(direction){
    currentPage += direction;
    renderTable();
}

function filterData(){
    const keyword = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
    const scoped = filterBySchoolMode(records);
    filteredRecordsCache = scoped.filter(item =>
        !keyword ||
        (item.nama||'').toLowerCase().includes(keyword) ||
        (item.kelas||'').toLowerCase().includes(keyword) ||
        (item.jurusan||'').toLowerCase().includes(keyword) ||
        (item.tahun_ajaran||'').toLowerCase().includes(keyword) ||
        (item.semester||'').toLowerCase().includes(keyword) ||
        (item.pelanggaran||'').toLowerCase().includes(keyword)
    );
    currentPage = 1;
    renderTable();
}

function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, m => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
    }[m]));
}
function escapeAttr(value){ return escapeHtml(value); }

/** Debounce helper */
function debounce(fn, wait = 250) {
    let t = null;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

/** Satu titik refresh UI setelah data/mode berubah */
function refreshViews(opts = {}) {
    const { chart = false, report = false, stats = true, recent = true, data = true } = opts;
    if (data) filterData();
    if (recent) renderRecent();
    if (stats) updateStats();
    if (chart && typeof updateChart === 'function') updateChart(records);
    if (report && typeof renderThreeStrikeReport === 'function') renderThreeStrikeReport();
    updateNamaSuggestions();
}

/** Fetch banyak URL paralel dengan concurrency terbatas */
async function fetchArrayBuffersParallel(urls, concurrency = 5) {
    const results = new Array(urls.length).fill(null);
    let idx = 0;
    async function worker() {
        while (idx < urls.length) {
            const i = idx++;
            const url = urls[i];
            if (!url) continue;
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error('HTTP ' + response.status);
                results[i] = await response.arrayBuffer();
            } catch (e) {
                console.warn('Fetch gagal:', url, e);
                results[i] = null;
            }
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, urls.length)) }, () => worker());
    await Promise.all(workers);
    return results;
}

/** Datalist saran nama siswa dari data existing */
function updateNamaSuggestions() {
    let dl = document.getElementById('nama-suggestions');
    if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'nama-suggestions';
        document.body.appendChild(dl);
        const namaInput = document.getElementById('nama');
        if (namaInput) namaInput.setAttribute('list', 'nama-suggestions');
    }
    const names = new Map();
    (records || []).forEach(r => {
        const n = String(r.nama || '').trim();
        if (!n) return;
        const key = normalizeName(n);
        if (!names.has(key)) names.set(key, n);
    });
    const sorted = [...names.values()].sort((a, b) => a.localeCompare(b, 'id'));
    dl.innerHTML = sorted.map(n => '<option value="' + escapeAttr(n) + '"></option>').join('');
}

function compressImage(file, maxWidth=800, quality=.7){
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = e => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                let width = img.width, height = img.height;
                if(width > maxWidth){
                    height = Math.round(height * maxWidth / width);
                    width = maxWidth;
                }
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                canvas.toBlob(blob => {
                    if(!blob) return reject(new Error('Gagal mengompres gambar'));
                    resolve(new File([blob], file.name.replace(/\.[^/.]+$/, '') + '.jpg', {
                        type: 'image/jpeg', lastModified: Date.now()
                    }));
                }, 'image/jpeg', quality);
            };
            img.onerror = reject;
        };
        reader.onerror = reject;
    });
}

async function loadData(){
    showAppLoading('Sedang memuat data pelanggaran...');
    try {
        // Batch load (1000/row) agar tetap aman saat data membesar
        const pageSize = 1000;
        let from = 0;
        let all = [];
        let useSoftDeleteFilter = true;

        while (true) {
            let query = _supabase
                .from('pelanggaran')
                .select('*')
                .order('id', { ascending: true })
                .range(from, from + pageSize - 1);

            // Sembunyikan data soft-deleted jika kolom deleted_at tersedia
            if (useSoftDeleteFilter) {
                query = query.is('deleted_at', null);
            }

            const { data, error } = await query;
            if (error) {
                // Kolom deleted_at belum ada → fallback tanpa filter
                if (useSoftDeleteFilter && /deleted_at/i.test(String(error.message || ''))) {
                    useSoftDeleteFilter = false;
                    continue;
                }
                throw error;
            }
            const chunk = data || [];
            all = all.concat(chunk);
            if (chunk.length < pageSize) break;
            from += pageSize;
        }

        await resolvePelanggaranStorageUrls(all);
        records = all;
        filteredRecordsCache = [...records];
        // Muat snapshot poin agar kartu menampilkan akumulasi berdasarkan aturan resmi.
        await loadViolationPointItems();
        await Promise.all([
            loadFollowUpsFromSupabase(),
            loadViolationCategories(),
            loadAllViolationPointRules().catch(err => { console.warn('Aturan resmi untuk laporan/grafik gagal dimuat:', err); return []; })
        ]);
        updateAdminUI();
        updateStats();
        updateChart(records);
        renderThreeStrikeReport();
        updateNamaSuggestions();
        appDataLoaded = true;
    } catch(error){
        console.error('Supabase error:', error);
        appDataLoaded = false;
        Swal.fire({
            icon: 'error',
            title: 'Koneksi Gagal',
            text: 'Gagal mengambil data dari Supabase: ' + (error?.message || error),
            confirmButtonColor: '#e53935'
        });
    } finally {
        hideAppLoading();
    }
}

/** Ambil semua pelanggaran siswa berdasarkan NAMA LENGKAP saja (konsisten dengan Report 3x) */
function getRecordsByStudentName(namaSiswa){
    const cleanName = normalizeName(namaSiswa);
    return records
        .filter(r => normalizeName(r.nama) === cleanName)
        .sort((a,b) =>
            String(a.tanggal||'').localeCompare(String(b.tanggal||'')) ||
            Number(a.id||0) - Number(b.id||0)
        );
}

/** Kelas terbaru dari riwayat siswa (nama saja) */
function getLatestClassByName(namaSiswa, fallbackKelas){
    const list = getRecordsByStudentName(namaSiswa);
    if(!list.length) return fallbackKelas || '-';
    const latest = [...list].sort((a,b) =>
        String(b.tanggal||'').localeCompare(String(a.tanggal||'')) ||
        Number(b.id||0) - Number(a.id||0)
    )[0];
    return String(latest?.kelas || fallbackKelas || '-').trim() || '-';
}

async function kirimWhatsAppManual(namaSiswa, kelasSiswa) {
    const listSiswa = getRecordsByStudentName(namaSiswa);
    const totalCount = listSiswa.length;
    const kelasTampil = getLatestClassByName(namaSiswa, kelasSiswa);

    const result = await Swal.fire({
        title: '📱 Beritahu Wali Kelas/Murid',
        html: `<p>Kirim pemberitahuan catatan pelanggaran siswa <strong>${escapeHtml(namaSiswa)}</strong> (${escapeHtml(kelasTampil)}) ke WhatsApp.</p>`,
        icon: 'question',
        input: 'text',
        inputLabel: 'Masukkan Nomor WA Tujuan:',
        inputPlaceholder: 'Contoh: 081234567890',
        showCancelButton: true,
        confirmButtonText: '📲 Kirim via WhatsApp',
        cancelButtonText: 'Batal',
        confirmButtonColor: '#25d366',
        inputValidator: (value) => { if (!value) return 'Nomor WhatsApp wajib diisi!'; }
    });

    if (result.isConfirmed && result.value) {
        let phone = result.value.trim().replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.slice(1);

        const daftarPelanggaran = listSiswa.map((item, idx) => `${idx + 1}. ${item.pelanggaran} (${formatTanggalIndonesia(item.tanggal)})`).join('\n');
        const message = `Yth. Bapak/Ibu Wali Murid / Wali Kelas dari *${namaSiswa}* (${kelasTampil}).\n\nBerikut menginformasikan catatan pelanggaran siswa di SMP - SMK Gelora Bekasi:\n*Total Pelanggaran:* ${totalCount} kali\n\nRiwayat Pelanggaran:\n${daftarPelanggaran}\n\nMohon untuk dilakukan pembinaan bersama.\n\nTerima kasih.\n*SMP - SMK Gelora Bekasi*`;

        window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
    }
}

async function checkPelanggaranCountAndPrompt(namaSiswa, kelasSiswa) {
    const listSiswa = getRecordsByStudentName(namaSiswa);
    const totalCount = listSiswa.length;
    const kelasTampil = getLatestClassByName(namaSiswa, kelasSiswa);

    if (totalCount >= 3) {
        const result = await Swal.fire({
            title: '⚠️ PERINGATAN PELANGGARAN 3X',
            html: `<p>Siswa <strong>${escapeHtml(namaSiswa)}</strong> (${escapeHtml(kelasTampil)}) telah mencapai <strong>${totalCount}x pelanggaran</strong>!</p>`,
            icon: 'warning',
            input: 'text',
            inputLabel: 'Masukkan Nomor WhatsApp Ortu/Wali:',
            inputPlaceholder: 'Contoh: 081234567890',
            showCancelButton: true,
            confirmButtonText: '📲 Kirim Surat Panggilan via WA',
            cancelButtonText: 'Tutup',
            confirmButtonColor: '#25d366',
            inputValidator: (value) => { if (!value) return 'Nomor WA wajib diisi!'; }
        });

        if (result.isConfirmed && result.value) {
            let phone = result.value.trim().replace(/[^0-9]/g, '');
            if (phone.startsWith('0')) phone = '62' + phone.slice(1);

            const daftarPelanggaran = listSiswa.map((item, idx) => `${idx + 1}. ${item.pelanggaran} (${formatTanggalIndonesia(item.tanggal)})`).join('\n');
            const message = `Yth. Bapak/Ibu Orang Tua/Wali dari *${namaSiswa}* (${kelasTampil}).\n\nBermaksud menginformasikan bahwa siswa tersebut telah mencapai *${totalCount} kali pelanggaran* di SMP - SMK Gelora Bekasi.\n\nRiwayat Pelanggaran:\n${daftarPelanggaran}\n\nSehubungan dengan hal tersebut, kami mengundang Bapak/Ibu hadir ke sekolah untuk bimbingan konseling.\n\nTerima kasih.\n*SMP - SMK Gelora Bekasi*`;

            window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
        }
    }
}

async function loadViolationPointRules(force = false, includeInactive = false){
    const select = document.getElementById('point-rule-select');
    const summary = document.getElementById('point-rule-summary');
    if (!select) return;
    if (violationPointRulesLoaded && !force && violationPointRulesIncludeInactive === includeInactive) {
        renderViolationPointRuleOptions();
        return;
    }
    select.disabled = true;
    if (summary) summary.textContent = 'Memuat aturan poin resmi...';
    try {
        let rulesQuery = _supabase
            .from('violation_point_rules')
            .select('code,name,severity,points,accumulation_scope,active')
            .order('code', { ascending: true });
        if (!includeInactive) rulesQuery = rulesQuery.eq('active', true);
        const { data, error } = await rulesQuery;
        if (error) throw error;
        violationPointRules = Array.isArray(data) ? data : [];
        violationPointRulesIncludeInactive = includeInactive;
        violationPointRulesLoaded = true;
        violationPointRulesError = null;
        renderViolationPointRuleOptions();
    } catch (error) {
        violationPointRulesLoaded = false;
        violationPointRulesError = error;
        select.innerHTML = '<option value="">Gagal memuat aturan resmi</option>';
        if (summary) summary.textContent = 'Aturan poin tidak berhasil dimuat. Simpan data baru dinonaktifkan sampai koneksi aturan pulih.';
        console.error('Gagal memuat aturan poin resmi:', error);
    } finally {
        select.disabled = !currentUser || !violationPointRulesLoaded;
        const list = document.getElementById('point-rule-checkboxes');
        if (list) {
            list.classList.toggle('is-disabled', select.disabled);
            list.querySelectorAll('input[type="checkbox"]').forEach(input => { input.disabled = select.disabled; });
        }
    }
}

function renderViolationPointRuleOptions(){
    const select = document.getElementById('point-rule-select');
    const list = document.getElementById('point-rule-checkboxes');
    if (!select || !list) return;
    const selected = new Set(Array.from(select.selectedOptions || []).map(o => o.value));
    select.innerHTML = '';
    list.innerHTML = '';
    if (!violationPointRules.length) {
        select.innerHTML = '<option value="">Tidak ada aturan aktif</option>';
        list.textContent = 'Tidak ada aturan aktif yang tersedia.';
    } else {
        violationPointRules.forEach(rule => {
            const option = document.createElement('option');
            option.value = rule.code;
            option.textContent = `${rule.code} — ${rule.name} (${rule.points} poin · ${rule.severity})${rule.active === false ? ' · nonaktif/historis' : ''}`;
            option.selected = selected.has(rule.code);
            option.disabled = rule.active === false && !selected.has(rule.code);
            select.appendChild(option);

            const label = document.createElement('label');
            label.className = 'point-rule-option';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = rule.code;
            checkbox.checked = selected.has(rule.code);
            checkbox.disabled = !currentUser || !violationPointRulesLoaded || (rule.active === false && !selected.has(rule.code));
            checkbox.addEventListener('change', () => {
                const target = Array.from(select.options).find(o => o.value === rule.code);
                if (target) target.selected = checkbox.checked;
                updateViolationPointSummary();
            });
            const text = document.createElement('span');
            text.className = 'point-rule-option-text';
            text.textContent = `${rule.code} — ${rule.name}${rule.active === false ? ' (nonaktif/historis)' : ''}`;
            const meta = document.createElement('small');
            meta.textContent = `${rule.points} poin · ${rule.severity}`;
            label.append(checkbox, text, meta);
            list.appendChild(label);
        });
    }
    list.classList.toggle('is-disabled', !currentUser || !violationPointRulesLoaded);
    updateViolationPointSummary();
}

function getSelectedViolationPointRules(){
    const select = document.getElementById('point-rule-select');
    if (!select) return [];
    const codes = new Set(Array.from(select.selectedOptions).map(o => o.value).filter(Boolean));
    return violationPointRules.filter(rule => codes.has(rule.code));
}

function updateViolationPointSummary(){
    const summary = document.getElementById('point-rule-summary');
    if (!summary) return;
    if (violationPointRulesError) {
        summary.textContent = 'Gagal memuat aturan resmi. Periksa koneksi Supabase lalu buka form kembali.';
        return;
    }
    const chosen = getSelectedViolationPointRules();
    const chosenCodes = new Set(chosen.map(rule => rule.code));
    document.querySelectorAll('#point-rule-checkboxes input[type="checkbox"]').forEach(input => {
        input.checked = chosenCodes.has(input.value);
    });
    if (!chosen.length) {
        summary.textContent = 'Belum ada aturan resmi dipilih. Catatan akan tersimpan tanpa pemetaan poin dan perlu ditinjau.';
        return;
    }
    const total = chosen.reduce((sum, rule) => sum + Number(rule.points || 0), 0);
    summary.textContent = `Dipilih ${chosen.length} aturan · Total snapshot poin ${total}. ` + chosen.map(r => `${r.code}: ${r.points} poin (${r.severity})`).join(' · ');
}

function setViolationPointRuleEditMode(isEditing){
    const group = document.getElementById('point-rule-group');
    const select = document.getElementById('point-rule-select');
    if (group) group.classList.toggle('is-editing', isEditing);
    if (select) {
        select.disabled = !currentUser || !violationPointRulesLoaded;
        select.removeAttribute('title');
    }
    const checkboxList = document.getElementById('point-rule-checkboxes');
    if (checkboxList) {
        checkboxList.classList.toggle('is-disabled', !currentUser || !violationPointRulesLoaded);
        checkboxList.querySelectorAll('input[type="checkbox"]').forEach(input => { input.disabled = !currentUser || !violationPointRulesLoaded; });
    }
    const help = document.getElementById('point-rule-help');
    if (help) help.textContent = isEditing
        ? 'Mode edit: centang atau hapus centang aturan, lalu tekan Update Data untuk menyimpan perubahan poin.'
        : 'Daftar dimuat dari aturan aktif di database. Pilih satu atau beberapa aturan yang sesuai; catatan yang belum pasti boleh dibiarkan tanpa pemetaan untuk ditinjau.';
}

document.getElementById('point-rule-select')?.addEventListener('change', updateViolationPointSummary);

async function simpanData(){
    if(!currentUser) return Swal.fire({
        icon: 'error',
        title: 'Akses Ditolak',
        text: 'Hanya Admin yang dapat menyimpan data.',
        confirmButtonColor: '#e53935'
    });

    const editId = document.getElementById('edit-id')?.value || '';
    const tanggal = document.getElementById('tanggal').value;
    const nama = document.getElementById('nama').value.trim();
    const kelas = document.getElementById('kelas').value.trim();
    // Mode form mengikuti role guru (bukan toggle filter data)
    const formMode = getFormSchoolMode();
    let jurusan = (document.getElementById('jurusan')?.value || '').trim();
    if (formMode === 'smp') jurusan = '';
    const tahun_ajaran = (document.getElementById('tahun_ajaran')?.value || '').trim();
    const semester = (document.getElementById('semester')?.value || '').trim();
    const pelanggaran = document.getElementById('pelanggaran').value.trim();
    let selectedPointCodes = getSelectedViolationPointRules().map(rule => rule.code);
    const fotoInput = document.getElementById('foto').files[0];
    const btn = document.getElementById('btn-save');

    if(!nama || !kelas || !pelanggaran){
        return Swal.fire({
            icon: 'warning',
            title: 'Form Inkomplit',
            text: 'Nama, Kelas, dan Pelanggaran wajib diisi!',
            confirmButtonColor: '#f97316'
        });
    }

    if (formMode === 'smk' && !jurusan) {
        return Swal.fire({
            icon: 'warning',
            title: 'Form Inkomplit',
            text: 'Jurusan wajib diisi untuk data SMK!',
            confirmButtonColor: '#f97316'
        });
    }

    if (!editId && !violationPointRulesLoaded) {
        await loadViolationPointRules(true);
        if (!violationPointRulesLoaded) {
            return Swal.fire({ icon: 'error', title: 'Aturan Poin Belum Tersedia', text: 'Data aturan resmi belum berhasil dimuat. Periksa koneksi lalu coba lagi.' });
        }
        selectedPointCodes = getSelectedViolationPointRules().map(rule => rule.code);
    }

    if (!editId && selectedPointCodes.length === 0) {
        const confirmUnmapped = await Swal.fire({
            icon: 'warning',
            title: 'Belum Memilih Aturan Poin',
            text: 'Catatan tetap dapat disimpan, tetapi tidak akan memiliki poin sampai aturan dikonfirmasi. Lanjutkan?',
            showCancelButton: true,
            confirmButtonText: 'Simpan untuk ditinjau',
            cancelButtonText: 'Pilih aturan dulu',
            confirmButtonColor: '#f97316'
        });
        if (!confirmUnmapped.isConfirmed) return;
    }

    btn.disabled = true;
    btn.textContent = 'Mengolah...';
    let fotoUrl = null;
    let uploadedFotoPath = null;
    let oldFotoUrl = null;
    if (editId) {
        const oldItem = records.find(r => String(r.id) === String(editId));
        oldFotoUrl = oldItem?.foto_url || null;
    }

    try{
        if(fotoInput){
            btn.textContent = 'Mengompres & Mengunggah Foto...';
            const compressed = await compressImage(fotoInput, 800, .7);
            const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;

            const {error: uploadError} = await _supabase.storage
                .from('foto-pelanggaran')
                .upload(fileName, compressed);

            if(uploadError) throw uploadError;

            fotoUrl = fileName;
            uploadedFotoPath = fileName;
        }

        if(editId){
            const payload = {
                tanggal, nama, kelas, pelanggaran,
                jurusan: jurusan || null,
                tahun_ajaran: tahun_ajaran || null,
                semester: semester || null
            };
            if(fotoUrl) payload.foto_url = fotoUrl;

            const {error} = await _supabase.from('pelanggaran').update(payload).eq('id', editId);
            if(error) throw error;

            // Simpan perubahan pemetaan poin saat edit, hanya jika pilihan berubah.
            const normalizedOriginal = [...editPointCodesOriginal].sort();
            const normalizedSelected = [...selectedPointCodes].sort();
            const pointSelectionChanged = JSON.stringify(normalizedOriginal) !== JSON.stringify(normalizedSelected);
            if (pointSelectionChanged) {
                const { error: deletePointError } = await _supabase
                    .from('pelanggaran_point_items')
                    .delete()
                    .eq('pelanggaran_id', editId);
                if (deletePointError) throw new Error('Data utama terupdate, tetapi detail poin gagal dibersihkan: ' + deletePointError.message);

                try {
                    if (selectedPointCodes.length) {
                        const selectedRules = violationPointRules.filter(rule => selectedPointCodes.includes(rule.code));
                        if (selectedRules.length !== selectedPointCodes.length) throw new Error('Ada aturan poin yang tidak lagi aktif atau tidak ditemukan. Muat ulang form dan coba lagi.');
                        const originalByCode = new Map(editPointItemsOriginal.map(row => [String(row.violation_code), row]));
                        const rows = selectedRules.map(rule => {
                            const original = originalByCode.get(String(rule.code));
                            return {
                                pelanggaran_id: Number(editId),
                                violation_code: rule.code,
                                points_snapshot: original ? original.points_snapshot : Number(rule.points),
                                severity_snapshot: original ? original.severity_snapshot : rule.severity,
                                accumulation_scope_snapshot: original ? original.accumulation_scope_snapshot : rule.accumulation_scope
                            };
                        });
                        const { error: insertPointError } = await _supabase.from('pelanggaran_point_items').insert(rows);
                        if (insertPointError) throw insertPointError;
                    }
                } catch (pointSaveError) {
                    // Best-effort rollback untuk mencegah detail lama hilang jika detail baru gagal disimpan.
                    if (editPointItemsOriginal.length) {
                        const restoreRows = editPointItemsOriginal.map(row => ({
                            pelanggaran_id: Number(editId),
                            violation_code: row.violation_code,
                            points_snapshot: row.points_snapshot,
                            severity_snapshot: row.severity_snapshot,
                            accumulation_scope_snapshot: row.accumulation_scope_snapshot
                        }));
                        const { error: restoreError } = await _supabase.from('pelanggaran_point_items').insert(restoreRows);
                        if (restoreError) console.error('Pemulihan detail poin lama gagal:', restoreError);
                    }
                    throw new Error('Perubahan data utama tersimpan, tetapi perubahan poin gagal: ' + pointSaveError.message + '. Periksa kembali laporan ini.');
                }
            }

            if (fotoUrl && oldFotoUrl && oldFotoUrl !== fotoUrl) {
                const oldPath = storagePathFromValue(oldFotoUrl);
                if (oldPath) await _supabase.storage.from(STORAGE_BUCKET).remove([oldPath]);
            }
            
            await catatLog('EDIT', `Mengubah pelanggaran siswa: ${nama} (${kelas})`);
            Swal.fire({
                icon: 'success',
                title: 'Tersimpan',
                text: 'Data berhasil diperbarui!',
                confirmButtonColor: '#21a366'
            });
        } else {
            const { data: newRecordId, error } = await _supabase.rpc('create_pelanggaran_with_points', {
                p_payload: {
                    tanggal, nama, kelas, pelanggaran, foto_url: fotoUrl,
                    jurusan: jurusan || null,
                    tahun_ajaran: tahun_ajaran || null,
                    semester: semester || null
                },
                p_violation_codes: selectedPointCodes
            });
            if(error) throw error;
            if (newRecordId === null || newRecordId === undefined) throw new Error('Data tersimpan tanpa ID laporan yang dapat diverifikasi.');
            
            await catatLog('TAMBAH', `Menambahkan pelanggaran '${pelanggaran}' untuk ${nama} (${kelas})`);
            Swal.fire({
                icon: 'success',
                title: 'Tersimpan',
                text: 'Data berhasil disimpan!',
                confirmButtonColor: '#21a366'
            });
        }

        batalEdit();
        await loadData();
        showPage('data');
        await checkPelanggaranCountAndPrompt(nama, kelas);

    } catch(err){
        if (uploadedFotoPath) {
            try { await _supabase.storage.from(STORAGE_BUCKET).remove([uploadedFotoPath]); } catch (cleanupErr) { console.warn('Gagal membersihkan foto upload:', cleanupErr); }
        }
        console.error(err);
        Swal.fire({
            icon: 'error',
            title: 'Gagal Menyimpan',
            text: 'Gagal menyimpan data: '+err.message,
            confirmButtonColor: '#e53935'
        });
    } finally {
        btn.disabled = !currentUser;
        btn.textContent = '💾 Simpan Data';
    }
}

function cetakSuratPanggilan(namaSiswa, kelasSiswa) {
    // Group by nama lengkap saja (sama dengan Report 3x)
    const listSiswa = getRecordsByStudentName(namaSiswa);
    const totalCount = listSiswa.length;
    const kelasTampil = getLatestClassByName(namaSiswa, kelasSiswa);
    const tgl = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

    let tabelPelanggaranHtml = listSiswa.map((item, idx) => `
        <tr>
            <td style="border:1px solid #000; padding:5px 6px; text-align:center;">${idx + 1}</td>
            <td style="border:1px solid #000; padding:5px 6px; text-align:center;">${escapeHtml(formatTanggalIndonesia(item.tanggal) || '-')}</td>
            <td style="border:1px solid #000; padding:5px 6px;">${escapeHtml(item.pelanggaran || '-')}</td>
        </tr>
    `).join('');

    const windowCetak = window.open('', '', 'width=900,height=800');
    windowCetak.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Surat Panggilan Orang Tua - ${escapeHtml(namaSiswa)}</title>
            <style>
                @page { 
                    size: A4 portrait; 
                    margin: 10mm 15mm; 
                }
                body { 
                    font-family: Arial, Helvetica, sans-serif; 
                    font-size: 11pt; 
                    line-height: 1.35; 
                    color: #000; 
                    margin: 0; 
                    padding: 0; 
                }
                .kop-surat { 
                    text-align: center; 
                    border-bottom: 3px double #000; 
                    padding-bottom: 6px; 
                    margin-bottom: 12px; 
                }
                .kop-surat h2 { margin: 0; font-size: 15pt; font-weight: bold; text-transform: uppercase; }
                .kop-surat p { margin: 2px 0; font-size: 9.5pt; }
                .judul-surat { text-align: center; margin: 10px 0 10px; }
                .judul-surat h4 { margin: 0; font-size: 12pt; text-decoration: underline; text-transform: uppercase; }
                .judul-surat p { margin: 2px 0 0 0; font-size: 10pt; }
                .content p { margin: 4px 0; }
                .table-data { width: 100%; border-collapse: collapse; margin: 4px 0; }
                .table-data td { padding: 2px 0; vertical-align: top; font-size: 11pt; }
                .table-info { width: 100%; border-collapse: collapse; margin: 6px 0; }
                .table-info th, .table-info td { border: 1px solid #000; font-size: 10.5pt; }
                .table-info th { background-color: #f2f2f2; padding: 5px; text-align: center; }
                .table-info td { padding: 5px 6px; }
                .ttd-wrapper { margin-top: 15px; float: right; width: 220px; text-align: center; font-size: 11pt; }
                .ttd-wrapper p { margin: 2px 0; }
                .space-ttd { height: 45px; }
                .clear { clear: both; }
            </style>
        </head>
        <body>
            <div class="kop-surat">
                <h2>SMP - SMK GELORA BEKASI</h2>
                <p>Jl. Raya Kp. Irian, RT.005/RW.003, Telk. Pucang, Kec. Bekasi Utara, Kota Bekasi, Jawa Barat 17121</p>
                <p>Telp: (021) 88985463</p>
            </div>
            <div class="judul-surat">
                <h4>Surat Panggilan Orang Tua / Wali Siswa</h4>
                <p>Nomor: 421.3 / BP-BK / ${new Date().getFullYear()}</p>
            </div>
            <div class="content">
                <p>Kepada Yth.<br><strong>Bapak / Ibu / Wali Murid dari ${escapeHtml(namaSiswa)}</strong><br>Di Tempat</p>
                <p>Dengan hormat,</p>
                <p>Sehubungan dengan catatan tata tertib sekolah, kami menginformasikan bahwa siswa tersebut di bawah ini telah mencapai <strong>${totalCount} kali pelanggaran</strong>:</p>
                
                <table class="table-data" style="margin-top: 6px;">
                    <tr><td width="130"><strong>Nama Siswa</strong></td><td width="10">:</td><td><strong>${escapeHtml(namaSiswa)}</strong></td></tr>
                    <tr><td><strong>Kelas</strong></td><td>:</td><td>${escapeHtml(kelasTampil)}</td></tr>
                </table>

                <p style="margin-top: 6px;"><strong>Rincian Riwayat Pelanggaran (${totalCount}x):</strong></p>
                <table class="table-info">
                    <thead><tr><th width="35">No</th><th width="110">Tanggal</th><th>Jenis Pelanggaran</th></tr></thead>
                    <tbody>${tabelPelanggaranHtml}</tbody>
                </table>

                <p style="margin-top: 6px;">Maka dari itu, kami mengharapkan kehadiran Bapak/Ibu/Wali Siswa ke sekolah pada:</p>
                <table class="table-data" style="margin-left: 15px;">
                    <tr><td width="120">Hari / Tanggal</td><td width="10">:</td><td>.......................................................</td></tr>
                    <tr><td>Waktu</td><td>:</td><td>08.00 WIB – Selesai</td></tr>
                    <tr><td>Tempat</td><td>:</td><td>Ruang Bimbingan Konseling (BK) SMP - SMK Gelora Bekasi</td></tr>
                    <tr><td>Bertemu</td><td>:</td><td>Guru BK / Kesiswaan</td></tr>
                </table>

                <p style="margin-top: 6px;">Mengingat pentingnya bimbingan bersama demi kebaikan siswa, kami sangat mengharapkan kehadiran Bapak/Ibu tepat pada waktunya.</p>
                <p style="margin-top: 4px;">Demikian surat panggilan ini kami sampaikan. Atas perhatian dan kerja samanya, kami ucapkan terima kasih.</p>
            </div>
            <div class="ttd-wrapper">
                <p>Bekasi, ${escapeHtml(tgl)}</p>
                <p>Mengetahui,</p>
                <p>Guru BK / Kesiswaan</p>
                <div class="space-ttd"></div>
                <p><strong>( ________________________ )</strong></p>
            </div>
            <div class="clear"></div>
        </body>
        </html>
    `);
    windowCetak.document.close();
    windowCetak.focus();
    setTimeout(() => { windowCetak.print(); }, 500);
}

async function editData(id){
    if(!currentUser) return Swal.fire({
        icon: 'error',
        title: 'Akses Ditolak',
        text: 'Hanya Admin yang dapat mengubah data.',
        confirmButtonColor: '#e53935'
    });
    const item = records.find(r => r.id === id);
    if(!item)return;

    document.getElementById('edit-id').value = item.id;
    document.getElementById('tanggal').value = item.tanggal
    ? item.tanggal.substring(0, 10)
    : '';
    document.getElementById('nama').value = item.nama||'';
    document.getElementById('kelas').value = item.kelas||'';
    const elJurusan = document.getElementById('jurusan');
    if(elJurusan) elJurusan.value = item.jurusan || '';
    const elTa = document.getElementById('tahun_ajaran');
    const elSem = document.getElementById('semester');
    if(elTa) elTa.value = item.tahun_ajaran || '';
    if(elSem) elSem.value = item.semester || '';
    document.getElementById('pelanggaran').value = item.pelanggaran||'';
    document.getElementById('foto').value = '';
    editPointItemsOriginal = [];
    editPointCodesOriginal = [];
    if (document.getElementById('point-rule-select')) {
        setViolationPointRuleEditMode(true);
        await loadViolationPointRules(true, true);
        const { data: pointItems, error: pointLoadError } = await _supabase
            .from('pelanggaran_point_items')
            .select('id,pelanggaran_id,violation_code,points_snapshot,severity_snapshot,accumulation_scope_snapshot')
            .eq('pelanggaran_id', id);
        if (pointLoadError) {
            console.error('Gagal memuat detail poin untuk edit:', pointLoadError);
            Swal.fire({ icon: 'error', title: 'Gagal Memuat Poin', text: 'Aturan poin lama tidak dapat dimuat. Periksa izin database lalu coba edit kembali.' });
            batalEdit();
            return;
        }
        editPointItemsOriginal = Array.isArray(pointItems) ? pointItems : [];
        editPointCodesOriginal = editPointItemsOriginal.map(row => row.violation_code);
        const select = document.getElementById('point-rule-select');
        Array.from(select.options).forEach(option => { option.selected = editPointCodesOriginal.includes(option.value); });
        renderViolationPointRuleOptions();
        setViolationPointRuleEditMode(true);
        updateViolationPointSummary();
    }
    document.getElementById('form-title').textContent = '✏️ Edit Pelanggaran';
    document.getElementById('btn-save').textContent = '🔄 Update Data';
    document.getElementById('btn-cancel').style.display = 'block';
    syncFormSchoolUI();
    if (getFormSchoolMode() === 'smp') {
        const elJ = document.getElementById('jurusan');
        if (elJ) elJ.value = '';
    }
    showPage('form');
}

function batalEdit(){
    editPointItemsOriginal = [];
    editPointCodesOriginal = [];
    const edit = document.getElementById('edit-id');
    if(edit) edit.value = '';
    document.getElementById('tanggal').value = getLocalDateISO();
    document.getElementById('nama').value = '';
    document.getElementById('kelas').value = '';
    const elJurusan = document.getElementById('jurusan');
    if(elJurusan) elJurusan.value = '';
    const { tahunAjaran, semester } = getDefaultTahunAjaranSemester();
    const elTa = document.getElementById('tahun_ajaran');
    const elSem = document.getElementById('semester');
    if(elTa) elTa.value = tahunAjaran;
    if(elSem) elSem.value = semester;
    document.getElementById('pelanggaran').value = '';
    document.getElementById('foto').value = '';
    if (document.getElementById('point-rule-select')) {
        Array.from(document.getElementById('point-rule-select').options).forEach(option => { option.selected = false; });
        setViolationPointRuleEditMode(false);
        updateViolationPointSummary();
        loadViolationPointRules(true, false).catch(err => console.warn('Gagal kembali ke daftar aturan aktif:', err));
    }
    document.getElementById('form-title').textContent = '➕ Tambah Pelanggaran';
    document.getElementById('btn-save').textContent = '💾 Simpan Data';
    document.getElementById('btn-cancel').style.display = 'none';
    syncFormSchoolUI();
}

async function hapusData(id){
    if(!currentUser) return Swal.fire({
        icon: 'error',
        title: 'Akses Ditolak',
        text: 'Hanya Admin yang dapat menghapus data.',
        confirmButtonColor: '#e53935'
    });

    const item = records.find(r => r.id === id);
    if(!item) return;

    const result = await Swal.fire({
        title: 'Konfirmasi Hapus',
        html: 'Data akan diarsipkan (soft-delete).<br><small style="color:#64748b">Jika kolom <code>deleted_at</code> belum ada di Supabase, sistem memakai hapus permanen.</small>',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#e53935',
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'Ya, Hapus',
        cancelButtonText: 'Batal'
    });

    if(!result.isConfirmed) return;

    try{
        // Soft-delete melalui RPC SECURITY DEFINER. Ini menghindari benturan
        // RLS UPDATE/SELECT saat deleted_at berubah dari NULL menjadi timestamp.
        const { data: softOk, error: softErr } = await _supabase
            .rpc('soft_delete_pelanggaran', { p_id: id });

        if (softErr) throw softErr;
        if (softOk !== true) {
            throw new Error('Data tidak ditemukan, sudah diarsipkan, atau di luar scope akun ini.');
        }

        await catatLog('HAPUS', 'Soft-delete pelanggaran: ' + item.nama + ' (' + item.kelas + ')');
        Swal.fire({
            icon: 'success',
            title: 'Diarsipkan',
            text: 'Data diarsipkan (soft-delete).',
            confirmButtonColor: '#21a366'
        });
        await loadData();
    }catch(err){
        console.error(err);
        Swal.fire({
            icon: 'error',
            title: 'Gagal Hapus',
            text: 'Gagal menghapus data: '+err.message,
            confirmButtonColor: '#e53935'
        });
    }
}




/* ========== MAINTENANCE DATABASE (Super Admin) ========== */
let databaseMaintenanceSnapshot = null;

async function dbMaintenanceFetchAll(table, columns, configure) {
    const all = [];
    for (let from = 0; ; from += 1000) {
        let query = _supabase.from(table).select(columns).range(from, from + 999);
        if (typeof configure === 'function') query = configure(query);
        const { data, error } = await query;
        if (error) throw error;
        const chunk = Array.isArray(data) ? data : [];
        all.push(...chunk);
        if (chunk.length < 1000) break;
    }
    return all;
}

async function calculateDatabaseMaintenanceAudit() {
    // Pelanggaran aktif dipakai untuk menilai apakah catatan tindak lanjut masih relevan.
    let violations = [];
    try {
        violations = await dbMaintenanceFetchAll('pelanggaran', 'id,nama,kelas,deleted_at', q => q.is('deleted_at', null).order('id', { ascending: true }));
    } catch (err) {
        if (!/deleted_at|column/i.test(String(err.message || err))) throw err;
        violations = await dbMaintenanceFetchAll('pelanggaran', 'id,nama,kelas', q => q.order('id', { ascending: true }));
    }
    const activeNames = new Set(violations.map(r => normalizeName(r.nama)).filter(Boolean));
    const followups = await dbMaintenanceFetchAll('tindak_lanjut', 'id,student_key,nama,kelas', q => q.order('id', { ascending: true }));
    const orphanFollowups = followups.filter(r => r.student_key && !activeNames.has(normalizeName(r.nama)));

    // Detail snapshot poin baru dianggap yatim jika ID induknya benar-benar tidak ada,
    // termasuk membiarkan detail yang induknya hanya diarsipkan/soft-delete.
    const allViolationIds = new Set((await dbMaintenanceFetchAll('pelanggaran', 'id', q => q.order('id', { ascending: true }))).map(r => String(r.id)));
    const pointItems = await dbMaintenanceFetchAll('pelanggaran_point_items', 'id,pelanggaran_id', q => q.order('id', { ascending: true }));
    const orphanPointItems = pointItems.filter(r => r.pelanggaran_id != null && !allViolationIds.has(String(r.pelanggaran_id)));
    return { violations: violations.length, followups: followups.length, pointItems: pointItems.length, orphanFollowups, orphanPointItems, auditedAt: new Date().toISOString() };
}

function renderDatabaseMaintenanceAudit(audit) {
    const body = document.getElementById('db-maintenance-body');
    const status = document.getElementById('db-maintenance-status');
    if (!body || !status) return;
    body.innerHTML = `
      <tr><td><strong>tindak_lanjut</strong></td><td>${audit.followups} catatan dibandingkan dengan pelanggaran aktif</td><td><strong>${audit.orphanFollowups.length}</strong></td><td>Catatan tanpa pelanggaran aktif</td></tr>
      <tr><td><strong>pelanggaran_point_items</strong></td><td>${audit.pointItems} detail dibandingkan dengan seluruh ID pelanggaran</td><td><strong>${audit.orphanPointItems.length}</strong></td><td>Detail yang ID induknya benar-benar tidak ada</td></tr>`;
    status.textContent = `Audit selesai ${new Date(audit.auditedAt).toLocaleString('id-ID')}. Ditemukan ${audit.orphanFollowups.length + audit.orphanPointItems.length} kandidat di 2 pemeriksaan relasi.`;
}

async function openDatabaseMaintenance() {
    if (!currentUser || currentUser.role !== 'superadmin') {
        return Swal.fire({ icon: 'error', title: 'Akses Ditolak', text: 'Maintenance Database hanya untuk Super Admin.' });
    }
    document.getElementById('db-maintenance-modal')?.classList.add('show');
    await auditDatabaseMaintenance();
}
function closeDatabaseMaintenance() { document.getElementById('db-maintenance-modal')?.classList.remove('show'); }

async function auditDatabaseMaintenance() {
    if (!currentUser || currentUser.role !== 'superadmin') return Swal.fire({ icon: 'error', title: 'Akses Ditolak', text: 'Hanya Super Admin.' });
    const status = document.getElementById('db-maintenance-status');
    const body = document.getElementById('db-maintenance-body');
    if (status) status.textContent = 'Sedang memeriksa relasi data Supabase…';
    if (body) body.innerHTML = '<tr><td colspan="4" style="text-align:center;">Memeriksa database…</td></tr>';
    try {
        databaseMaintenanceSnapshot = await calculateDatabaseMaintenanceAudit();
        renderDatabaseMaintenanceAudit(databaseMaintenanceSnapshot);
    } catch (err) {
        databaseMaintenanceSnapshot = null;
        if (status) status.textContent = 'Audit gagal. Tidak ada data yang dihapus.';
        if (body) body.innerHTML = `<tr><td colspan="4" style="color:#b91c1c;">${escapeHtml(err.message || String(err))}</td></tr>`;
    }
}

async function cleanAllDatabaseOrphans() {
    if (!currentUser || currentUser.role !== 'superadmin') return Swal.fire({ icon: 'error', title: 'Akses Ditolak', text: 'Hanya Super Admin.' });
    let audit;
    try {
        // Hitung ulang tepat sebelum konfirmasi; jangan memakai hasil audit yang kedaluwarsa.
        audit = await calculateDatabaseMaintenanceAudit();
    } catch (err) {
        return Swal.fire({ icon: 'error', title: 'Audit Gagal', text: `${err.message || err}. Tidak ada data yang dihapus.` });
    }
    const total = audit.orphanFollowups.length + audit.orphanPointItems.length;
    if (!total) {
        databaseMaintenanceSnapshot = audit;
        renderDatabaseMaintenanceAudit(audit);
        return Swal.fire({ icon: 'success', title: 'Database Bersih', text: 'Tidak ditemukan kandidat yatim pada pemeriksaan yang didukung.' });
    }
    const confirm = await Swal.fire({
        icon: 'warning', title: 'Konfirmasi Pembersihan',
        html: `Akan dihapus:<br><strong>${audit.orphanFollowups.length}</strong> catatan tindak lanjut tanpa pelanggaran aktif<br><strong>${audit.orphanPointItems.length}</strong> detail poin tanpa baris induk pelanggaran.<br><br>Data master, siswa tanpa pelanggaran, dan riwayat yang masih memiliki induk tidak disentuh.`,
        showCancelButton: true, confirmButtonText: `Bersihkan ${total} Kandidat`, cancelButtonText: 'Batal', confirmButtonColor: '#dc2626', reverseButtons: true
    });
    if (!confirm.isConfirmed) return;
    Swal.fire({ title: 'Membersihkan database…', allowOutsideClick: false, allowEscapeKey: false, didOpen: () => Swal.showLoading() });
    let deletedFollowups = 0, deletedItems = 0;
    try {
        for (let i = 0; i < audit.orphanFollowups.length; i += 50) {
            const keys = audit.orphanFollowups.slice(i, i + 50).map(r => r.student_key);
            const { data, error } = await _supabase.from('tindak_lanjut').delete().in('student_key', keys).select('student_key');
            if (error) throw error;
            deletedFollowups += (data || []).length;
        }
        const orphanParentIds = [...new Set(audit.orphanPointItems.map(r => r.pelanggaran_id).filter(v => v != null))];
        for (let i = 0; i < orphanParentIds.length; i += 50) {
            const ids = orphanParentIds.slice(i, i + 50);
            const { data, error } = await _supabase.from('pelanggaran_point_items').delete().in('pelanggaran_id', ids).select('id');
            if (error) throw error;
            deletedItems += (data || []).length;
        }
        await catatLog('DATABASE_MAINTENANCE', `Pembersihan kandidat relasi: tindak_lanjut=${deletedFollowups}, pelanggaran_point_items=${deletedItems}`);
        databaseMaintenanceSnapshot = await calculateDatabaseMaintenanceAudit();
        renderDatabaseMaintenanceAudit(databaseMaintenanceSnapshot);
        Swal.close();
        await Swal.fire({ icon: 'success', title: 'Pembersihan Selesai', html: `Terhapus: <strong>${deletedFollowups}</strong> tindak lanjut dan <strong>${deletedItems}</strong> detail poin yatim.`, confirmButtonColor: '#16a34a' });
    } catch (err) {
        Swal.close();
        await Swal.fire({ icon: 'error', title: 'Pembersihan Tidak Tuntas', html: `Sebagian proses mungkin sudah berjalan sebelum terjadi kesalahan.<br><small>${escapeHtml(err.message || String(err))}</small><br>Jalankan Audit Ulang untuk memeriksa keadaan terkini.`, confirmButtonColor: '#dc2626' });
        await auditDatabaseMaintenance();
    }
}


/* ========== ARSIP SOFT-DELETE (Super Admin) ========== */
let archivedRecordsCache = [];

function removeFotoFromStorage(fotoUrl) {
    const path = storagePathFromValue(fotoUrl);
    if (!path) return Promise.resolve();
    return _supabase.storage.from(STORAGE_BUCKET).remove([path]).then(({ error }) => {
        if (error) console.warn('Gagal hapus foto storage:', error);
    });
}

async function openArchiveModal() {
    if (!currentUser || currentUser.role !== 'superadmin') {
        return Swal.fire({
            icon: 'error',
            title: 'Akses Ditolak',
            text: 'Hanya Super Admin yang dapat mengakses arsip.',
            confirmButtonColor: '#e53935'
        });
    }
    document.getElementById('archive-modal').classList.add('show');
    await loadArchivedRecords();
}

function closeArchiveModal() {
    const el = document.getElementById('archive-modal');
    if (el) el.classList.remove('show');
}

async function loadArchivedRecords() {
    const tbody = document.getElementById('archive-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Memuat arsip...</td></tr>';

    try {
        const pageSize = 500;
        let from = 0;
        let all = [];
        while (true) {
            const { data, error } = await _supabase
                .from('pelanggaran')
                .select('*')
                .not('deleted_at', 'is', null)
                .order('deleted_at', { ascending: false })
                .range(from, from + pageSize - 1);
            if (error) {
                if (/deleted_at|column|schema/i.test(String(error.message || ''))) {
                    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#b45309;">Kolom <code>deleted_at</code> belum ada. Jalankan SQL migrasi soft-delete dulu.</td></tr>';
                    archivedRecordsCache = [];
                    return;
                }
                throw error;
            }
            const chunk = data || [];
            all = all.concat(chunk);
            if (chunk.length < pageSize) break;
            from += pageSize;
        }
        archivedRecordsCache = all;
        renderArchiveTable();
    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:red;">Gagal memuat arsip: ' + escapeHtml(err.message || err) + '</td></tr>';
    }
}

function renderArchiveTable() {
    const tbody = document.getElementById('archive-table-body');
    if (!tbody) return;
    if (!archivedRecordsCache.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Arsip kosong. Tidak ada data soft-delete.</td></tr>';
        return;
    }
    tbody.innerHTML = archivedRecordsCache.map(item => {
        const tglArsip = item.deleted_at
            ? new Date(item.deleted_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })
            : '-';
        const pelangShort = String(item.pelanggaran || '-');
        const pelangShow = pelangShort.length > 48 ? pelangShort.slice(0, 46) + '…' : pelangShort;
        return `<tr>
            <td style="font-size:11px;white-space:nowrap;">${escapeHtml(tglArsip)}</td>
            <td><strong>${escapeHtml(item.nama || '-')}</strong></td>
            <td>${escapeHtml(item.kelas || '-')}</td>
            <td style="font-size:11px;max-width:180px;">${escapeHtml(pelangShow)}</td>
            <td style="white-space:nowrap;">
                <button class="edit-btn" style="padding:4px 8px;margin-right:4px;" onclick="restoreArchivedRecord(${Number(item.id)})">♻️ Pulihkan</button>
                <button class="delete-btn" style="padding:4px 8px;" onclick="hardDeleteArchivedRecord(${Number(item.id)})">🗑 Permanen</button>
            </td>
        </tr>`;
    }).join('');
}

async function restoreArchivedRecord(id) {
    if (!currentUser || currentUser.role !== 'superadmin') {
        return Swal.fire({ icon: 'error', title: 'Akses Ditolak', text: 'Hanya Super Admin.', confirmButtonColor: '#e53935' });
    }
    const item = archivedRecordsCache.find(r => Number(r.id) === Number(id));
    const confirm = await Swal.fire({
        title: 'Pulihkan data?',
        text: item ? `${item.nama} (${item.kelas}) akan kembali ke daftar aktif.` : 'Data akan dikembalikan ke daftar aktif.',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#21a366',
        confirmButtonText: 'Ya, Pulihkan',
        cancelButtonText: 'Batal'
    });
    if (!confirm.isConfirmed) return;

    try {
        const { error } = await _supabase
            .from('pelanggaran')
            .update({ deleted_at: null })
            .eq('id', id);
        if (error) throw error;
        await catatLog('EDIT', `Memulihkan arsip pelanggaran id=${id}` + (item ? `: ${item.nama}` : ''));
        Swal.fire({ icon: 'success', title: 'Dipulihkan', text: 'Data kembali aktif.', confirmButtonColor: '#21a366' });
        await loadArchivedRecords();
        await loadData();
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Gagal', text: err.message || String(err), confirmButtonColor: '#e53935' });
    }
}

async function hardDeleteArchivedRecord(id) {
    if (!currentUser || currentUser.role !== 'superadmin') {
        return Swal.fire({ icon: 'error', title: 'Akses Ditolak', text: 'Hanya Super Admin.', confirmButtonColor: '#e53935' });
    }
    const item = archivedRecordsCache.find(r => Number(r.id) === Number(id));
    if (!item) {
        return Swal.fire({ icon: 'warning', title: 'Tidak ditemukan', text: 'Muat ulang daftar arsip.', confirmButtonColor: '#f97316' });
    }

    const confirm = await Swal.fire({
        title: 'Hapus permanen?',
        html: `Data <strong>${escapeHtml(item.nama || '-')}</strong> akan dihapus total dari database + foto storage.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#e53935',
        confirmButtonText: 'Ya, Hapus Permanen',
        cancelButtonText: 'Batal'
    });
    if (!confirm.isConfirmed) return;

    try {
        await removeFotoFromStorage(item.foto_url);
        const { error } = await _supabase.from('pelanggaran').delete().eq('id', id);
        if (error) throw error;
        await catatLog('HAPUS', `Hard-delete arsip id=${id}: ${item.nama} (${item.kelas})`);
        Swal.fire({ icon: 'success', title: 'Terhapus permanen', text: 'Data & foto (jika ada) sudah dihapus.', confirmButtonColor: '#21a366' });
        await loadArchivedRecords();
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Gagal', text: err.message || String(err), confirmButtonColor: '#e53935' });
    }
}

async function purgeOldArchives(days = 30) {
    if (!currentUser || currentUser.role !== 'superadmin') {
        return Swal.fire({ icon: 'error', title: 'Akses Ditolak', text: 'Hanya Super Admin.', confirmButtonColor: '#e53935' });
    }
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const targets = archivedRecordsCache.filter(r => r.deleted_at && new Date(r.deleted_at) < cutoff);
    if (!targets.length) {
        return Swal.fire({ icon: 'info', title: 'Kosong', text: `Tidak ada arsip lebih tua dari ${days} hari.`, confirmButtonColor: '#f97316' });
    }
    const confirm = await Swal.fire({
        title: `Hapus ${targets.length} arsip lama?`,
        html: `Semua data yang diarsipkan sebelum <strong>${cutoff.toLocaleDateString('id-ID')}</strong> akan dihapus permanen.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#e53935',
        confirmButtonText: 'Ya, Hapus',
        cancelButtonText: 'Batal'
    });
    if (!confirm.isConfirmed) return;
    await hardDeleteManyArchived(targets, `arsip_lebih_dari_${days}_hari`);
}

async function purgeAllArchives() {
    if (!currentUser || currentUser.role !== 'superadmin') {
        return Swal.fire({ icon: 'error', title: 'Akses Ditolak', text: 'Hanya Super Admin.', confirmButtonColor: '#e53935' });
    }
    if (!archivedRecordsCache.length) {
        return Swal.fire({ icon: 'info', title: 'Kosong', text: 'Arsip sudah kosong.', confirmButtonColor: '#f97316' });
    }
    const confirm = await Swal.fire({
        title: 'Kosongkan SEMUA arsip?',
        html: `<strong>${archivedRecordsCache.length}</strong> data akan dihapus permanen. Tidak bisa dibatalkan.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#e53935',
        confirmButtonText: 'Ya, Kosongkan Semua',
        cancelButtonText: 'Batal'
    });
    if (!confirm.isConfirmed) return;
    await hardDeleteManyArchived([...archivedRecordsCache], 'semua_arsip');
}

async function hardDeleteManyArchived(items, label) {
    try {
        Swal.fire({ title: 'Menghapus permanen...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        let ok = 0, fail = 0;
        for (const item of items) {
            try {
                await removeFotoFromStorage(item.foto_url);
                const { error } = await _supabase.from('pelanggaran').delete().eq('id', item.id);
                if (error) throw error;
                ok++;
            } catch (e) {
                console.warn('Gagal hapus id', item.id, e);
                fail++;
            }
        }
        await catatLog('HAPUS', `Hard-delete massal arsip (${label}): sukses ${ok}, gagal ${fail}`);
        Swal.fire({
            icon: fail ? 'warning' : 'success',
            title: 'Selesai',
            text: `Berhasil: ${ok}` + (fail ? `, gagal: ${fail}` : ''),
            confirmButtonColor: '#21a366'
        });
        await loadArchivedRecords();
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Gagal', text: err.message || String(err), confirmButtonColor: '#e53935' });
    }
}


/* ========== LAZY LOAD MODUL EXPORT ========== */
let __exportLoadPromise = null;

function __loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-smp-src="' + src + '"]');
        if (existing) {
            if (existing.dataset.loaded === '1') return resolve();
            if (existing.dataset.failed === '1') { existing.remove(); }
            else {
                existing.addEventListener('load', () => resolve());
                existing.addEventListener('error', () => reject(new Error('Gagal memuat ' + src)));
                return;
            }
        }
        const el = document.createElement('script');
        el.src = src;
        el.async = true;
        el.dataset.smpSrc = src;
        el.onload = () => { el.dataset.loaded = '1'; resolve(); };
        el.onerror = () => { el.dataset.failed = '1'; reject(new Error('Gagal memuat skrip: ' + src)); };
        document.head.appendChild(el);
    });
}

function __resolveExportScriptUrl() {
    const mainScript = document.querySelector('script[src*="smpgelora.js"]');
    if (mainScript && mainScript.getAttribute('src')) {
        const src = mainScript.getAttribute('src');
        if (src.includes('smpgelora.js')) {
            return src.replace(/smpgelora\.js(\?.*)?$/, 'smpgelora-export.js$1');
        }
    }
    try {
        const base = document.querySelector('base')?.href || window.location.href;
        return new URL('smpgelora-export.js', base).href;
    } catch (_) {
        return 'smpgelora-export.js';
    }
}

async function __loadScriptWithFallback(urls, checkFn, label) {
    let lastErr = null;
    for (const url of urls) {
        try {
            document.querySelectorAll('script[data-smp-src="' + url + '"]').forEach(el => {
                if (el.dataset.failed === '1' || (el.dataset.loaded === '1' && !checkFn())) el.remove();
            });
            if (!checkFn()) await __loadScript(url);
            await new Promise(r => setTimeout(r, 40));
            if (checkFn()) return;
            lastErr = new Error(label + ' tidak tersedia setelah memuat: ' + url);
        } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Gagal memuat ' + label);
}

function ensureExportModule() {
    if (window.__smpgeloraExport && typeof window.__smpgeloraExport.exportToExcel === 'function' && typeof window.ExcelJS !== 'undefined') {
        return Promise.resolve(window.__smpgeloraExport);
    }
    if (__exportLoadPromise) return __exportLoadPromise;
    __exportLoadPromise = (async () => {
        if (typeof window.ExcelJS === 'undefined') {
            await __loadScriptWithFallback([
                'https://cdn.jsdelivr.net/npm/exceljs@4.3.0/dist/exceljs.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js',
                'https://unpkg.com/exceljs@4.3.0/dist/exceljs.min.js'
            ], () => typeof window.ExcelJS !== 'undefined', 'ExcelJS');
        }
        if (typeof window.JSZip === 'undefined') {
            await __loadScriptWithFallback([
                'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
                'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'
            ], () => typeof window.JSZip !== 'undefined', 'JSZip');
        }
        if (typeof window.ExcelJS === 'undefined') throw new Error('ExcelJS gagal dimuat. Cek koneksi internet.');
        const exportUrl = __resolveExportScriptUrl();
        document.querySelectorAll('script[data-smp-src="' + exportUrl + '"]').forEach(el => el.remove());
        document.querySelectorAll('script[src*="smpgelora-export.js"]').forEach(el => { if (!el.dataset.smpSrc) el.remove(); });
        window.__smpgeloraExport = null;
        await __loadScript(exportUrl);
        if (!window.__smpgeloraExport || typeof window.__smpgeloraExport.exportToExcel !== 'function') {
            throw new Error('Modul export gagal dimuat dari: ' + exportUrl + '. Pastikan smpgelora-export.js ikut di-upload.');
        }
        return window.__smpgeloraExport;
    })().catch(err => { __exportLoadPromise = null; throw err; });
    return __exportLoadPromise;
}


async function exportToExcel() {
    try {
        Swal.fire({
            title: 'Menyiapkan export...',
            text: 'Memuat modul Excel',
            allowOutsideClick: false,
            didOpen: () => Swal.showLoading()
        });
        const mod = await ensureExportModule();
        Swal.close();
        return await mod.exportToExcel();
    } catch (err) {
        console.error(err);
        Swal.fire({
            icon: 'error',
            title: 'Export Gagal',
            text: err.message || String(err),
            confirmButtonColor: '#e53935'
        });
    }
}

async function exportThreeStrikeReport() {
    try {
        Swal.fire({
            title: 'Menyiapkan export...',
            text: 'Memuat modul Excel',
            allowOutsideClick: false,
            didOpen: () => Swal.showLoading()
        });
        const mod = await ensureExportModule();
        Swal.close();
        return await mod.exportThreeStrikeReport();
    } catch (err) {
        console.error(err);
        Swal.fire({
            icon: 'error',
            title: 'Export Gagal',
            text: err.message || String(err),
            confirmButtonColor: '#e53935'
        });
    }
}


// Keep the UI synchronized with the real Supabase Auth session.
_supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
        currentUser = null;
        authReady = true;
        appDataLoaded = false;
        records = [];
        filteredRecordsCache = [];
        updateAdminUI();
        showLoginGate();
        hideAppLoading();
        return;
    }
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') && session) {
        try {
            currentUser = await getCurrentAppUser();
            authReady = true;
            updateAdminUI();
        } catch (err) {
            console.error('Gagal memuat profil Auth:', err);
            currentUser = null;
            authReady = true;
        }
    }
});

/* ========== BOOTSTRAP APP ========== */
(async function bootstrapApp(){
    try {
        const savedPageOnRefresh = localStorage.getItem('smpgelora_current_page') || 'home';
        showAppLoading('Sedang memuat data...');
        showPage(savedPageOnRefresh);
        await restoreAuthSession();
        updateAdminUI();
        (function initDefaultTA(){
            const { tahunAjaran, semester } = getDefaultTahunAjaranSemester();
            const elTa = document.getElementById('tahun_ajaran');
            const elSem = document.getElementById('semester');
            if(elTa && !elTa.value) elTa.value = tahunAjaran;
            if(elSem && !elSem.value) elSem.value = semester;
        })();
        document.querySelectorAll('.school-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === schoolMode);
        });
        syncSchoolModeUI();
        applyUserJenjangMode();
        const debouncedFilterData = debounce(() => filterData(), 280);
        const debouncedReport = debounce(() => {
            if (typeof renderThreeStrikeReport === 'function') renderThreeStrikeReport();
        }, 280);
        const searchInputEl = document.getElementById('search-input');
        if (searchInputEl) { searchInputEl.oninput = null; searchInputEl.addEventListener('input', debouncedFilterData); }
        const reportSearchEl = document.getElementById('report-search');
        if (reportSearchEl) { reportSearchEl.oninput = null; reportSearchEl.addEventListener('input', debouncedReport); }
        if (currentUser) {
            await loadData();
            hideLoginGate();
        } else {
            showLoginGate();
            hideAppLoading();
        }
    } catch (err) {
        console.error('Bootstrap gagal:', err);
        if (typeof hideAppLoading === 'function') hideAppLoading();
        if (typeof Swal !== 'undefined') {
            Swal.fire({ icon: 'error', title: 'Gagal memuat aplikasi', text: err.message || String(err), confirmButtonColor: '#e53935' });
        }
    }
})();

