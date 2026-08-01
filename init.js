// ============================================================
// FDQH MongoDB Database Engine
// Uses MONGODB_URI environment variable
// ============================================================
const { MongoClient } = require('mongodb');

let client = null;
let db = null;
const DB_NAME = 'fdqh';
let isConnected = false;

class MongoDatabase {
  constructor() {
    this.collections = { users: [], products: [], suppliers: [], quality_events: [], capa_records: [], change_records: [], audit_logs: [], documents: [] };
    this._connectTimer = null;
  }

  async connect() {
    if (isConnected && db) return;
    
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.warn('⚠️ MONGODB_URI not set, falling back to JSON file storage');
      return this._initJsonFallback();
    }

    try {
      client = new MongoClient(uri, { 
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
      });
      await client.connect();
      db = client.db(DB_NAME);
      isConnected = true;
      console.log('✅ Connected to MongoDB: ' + DB_NAME);
      
      // Ensure indexes
      await db.collection('users').createIndex({ username: 1 }, { unique: true });
      await db.collection('quality_events').createIndex({ status: 1 });
      await db.collection('capa_records').createIndex({ status: 1 });
      await db.collection('audit_logs').createIndex({ table_name: 1, record_id: 1 });
      
      // Seed if empty
      await this._checkAndSeed();
      return;
    } catch (err) {
      console.error('MongoDB connection failed:', err.message);
      console.warn('Falling back to JSON file storage');
      return this._initJsonFallback();
    }
  }

  // ---- JSON Fallback ----
  _initJsonFallback() {
    console.log('📁 Using JSON file-based storage');
    const fs = require('fs');
    const path = require('path');
    const DB_DIR = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    
    const tables = ['users', 'products', 'suppliers', 'quality_events', 'capa_records', 'change_records', 'audit_logs', 'documents'];
    const self = this;
    tables.forEach(function(t) {
      const file = path.join(DB_DIR, t + '.json');
      self.collections[t] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    });
    
    // Seed users if empty
    if (this.collections.users.length === 0) {
      const bcrypt = require('bcryptjs');
      this.collections.users = [
        { id: 'U001', username: 'admin', password: bcrypt.hashSync('admin123', 10), role: 'admin', name: '系统管理员', base: '集团', dept: '质量部', created_at: new Date().toISOString() },
        { id: 'U002', username: 'qa_manager', password: bcrypt.hashSync('qa123', 10), role: 'manager', name: 'QA经理', base: '上海基地', dept: 'QA', created_at: new Date().toISOString() },
        { id: 'U003', username: 'qa_engineer', password: bcrypt.hashSync('qa123', 10), role: 'user', name: '质量工程师', base: '上海基地', dept: 'QA', created_at: new Date().toISOString() },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'users.json'), JSON.stringify(self.collections.users, null, 2));
    }
    
    // Seed demo data
    this._seedJsonDemoData();
    isConnected = false;
  }

  _seedJsonDemoData() {
    const fs = require('fs');
    const path = require('path');
    const DB_DIR = path.join(__dirname, '..', 'data');
    const self = this;

    if (this.collections.products.length === 0) {
      this.collections.products = [
        { id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', platform: '试剂', risk_class: 'III', lifecycle_status: '生产', regulatory_status: '已注册' },
        { id: 'P002', product_name: '全自动化学发光免疫分析仪', platform: '仪器', risk_class: 'II', lifecycle_status: '生产', regulatory_status: '已注册' },
        { id: 'P003', product_name: '血糖检测试剂盒', platform: '试剂', risk_class: 'II', lifecycle_status: '研发', regulatory_status: '注册中' },
        { id: 'P004', product_name: '新冠抗原检测试剂盒', platform: '试剂', risk_class: 'III', lifecycle_status: '生产', regulatory_status: '已注册' },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'products.json'), JSON.stringify(this.collections.products, null, 2));
    }
    if (this.collections.suppliers.length === 0) {
      this.collections.suppliers = [
        { id: 'S001', supplier_name: '博奥生物', category: '抗原原料', risk_level: 'Low', quality_score: 95.5, certification: 'ISO 13485' },
        { id: 'S002', supplier_name: '华大智造', category: '仪器配件', risk_level: 'Medium', quality_score: 88.0, certification: 'ISO 9001' },
        { id: 'S003', supplier_name: '上海生物制品研究所', category: '标准品', risk_level: 'Low', quality_score: 92.0, certification: 'ISO 13485/GMP' },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'suppliers.json'), JSON.stringify(this.collections.suppliers, null, 2));
    }
    if (this.collections.quality_events.length === 0) {
      this.collections.quality_events = [
        { id: 'QE001', event_type: 'Deviation', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: 'B202401001', risk_level: 'High', status: 'In Investigation', description: '灌装线温度超限报警，持续15分钟超出规格上限2°C', reported_by: 'qa_engineer', created_at: '2026-07-15T09:30:00Z' },
        { id: 'QE002', event_type: 'OOS', product_id: 'P004', product_name: '新冠抗原检测试剂盒', batch_no: 'B202401050', risk_level: 'Critical', status: 'Open', description: '成品检测项灵敏度指标超出标准范围下限', reported_by: 'qa_engineer', created_at: '2026-07-20T14:00:00Z' },
        { id: 'QE003', event_type: 'Complaint', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: 'B202312120', risk_level: 'Medium', status: 'Closed', description: '客户反馈试剂盒包装破损导致试剂泄漏', reported_by: 'qa_manager', created_at: '2026-06-01T10:00:00Z' },
        { id: 'QE004', event_type: 'Deviation', product_id: 'P002', product_name: '全自动化学发光免疫分析仪', batch_no: 'M202402001', risk_level: 'Medium', status: 'In Investigation', description: '仪器校准参数偏差超过警戒线', reported_by: 'qa_engineer', created_at: '2026-07-25T08:00:00Z' },
        { id: 'QE005', event_type: 'CAPA', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: '', risk_level: 'Low', status: 'Open', description: '内审发现文件控制流程存在缺陷', reported_by: 'qa_manager', created_at: '2026-07-28T16:00:00Z' },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'quality_events.json'), JSON.stringify(this.collections.quality_events, null, 2));
    }
    if (this.collections.capa_records.length === 0) {
      this.collections.capa_records = [
        { id: 'CAPA001', event_id: 'QE003', title: '包装破损根因纠正', root_cause: '运输过程中外箱承压不足', action_plan: '1)升级外箱材质 2)增加缓冲材料 3)修订包装SOP', status: 'Closed', assignee: '包装工程师', due_date: '2026-07-15', effectiveness: '有效', created_at: '2026-06-05T09:00:00Z' },
        { id: 'CAPA002', event_id: 'QE002', title: 'OOS成品灵敏度异常调查', root_cause: '调查中', action_plan: '待确定根因后制定', status: 'In Progress', assignee: 'QA工程师', due_date: '2026-08-15', effectiveness: '', created_at: '2026-07-21T09:00:00Z' },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'capa_records.json'), JSON.stringify(this.collections.capa_records, null, 2));
    }
    if (this.collections.change_records.length === 0) {
      this.collections.change_records = [
        { id: 'CHG001', change_type: '工艺变更', product_id: 'P001', risk: 'High', impact: '变更灌装线温度控制参数，可能影响产品稳定性', validation_status: '待验证', status: 'Pending Approval', initiator: '工艺工程师', created_at: '2026-07-10T10:00:00Z' },
        { id: 'CHG002', change_type: '设备变更', product_id: 'P002', risk: 'Medium', impact: '更换仪器校准标准品供应商', validation_status: '已验证', status: 'Approved', initiator: '设备工程师', created_at: '2026-06-20T14:00:00Z' },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'change_records.json'), JSON.stringify(this.collections.change_records, null, 2));
    }
  }

  // ---- MongoDB Seed ----
  async _checkAndSeed() {
    const count = await db.collection('users').countDocuments();
    if (count === 0) {
      const bcrypt = require('bcryptjs');
      await db.collection('users').insertMany([
        { id: 'U001', username: 'admin', password: bcrypt.hashSync('admin123', 10), role: 'admin', name: '系统管理员', base: '集团', dept: '质量部', created_at: new Date().toISOString() },
        { id: 'U002', username: 'qa_manager', password: bcrypt.hashSync('qa123', 10), role: 'manager', name: 'QA经理', base: '上海基地', dept: 'QA', created_at: new Date().toISOString() },
        { id: 'U003', username: 'qa_engineer', password: bcrypt.hashSync('qa123', 10), role: 'user', name: '质量工程师', base: '上海基地', dept: 'QA', created_at: new Date().toISOString() },
      ]);
      console.log('✅ Seeded users collection');
    }

    const prodCount = await db.collection('products').countDocuments();
    if (prodCount === 0) {
      await db.collection('products').insertMany([
        { id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', platform: '试剂', risk_class: 'III', lifecycle_status: '生产', regulatory_status: '已注册' },
        { id: 'P002', product_name: '全自动化学发光免疫分析仪', platform: '仪器', risk_class: 'II', lifecycle_status: '生产', regulatory_status: '已注册' },
        { id: 'P003', product_name: '血糖检测试剂盒', platform: '试剂', risk_class: 'II', lifecycle_status: '研发', regulatory_status: '注册中' },
        { id: 'P004', product_name: '新冠抗原检测试剂盒', platform: '试剂', risk_class: 'III', lifecycle_status: '生产', regulatory_status: '已注册' },
      ]);
    }
    const supCount = await db.collection('suppliers').countDocuments();
    if (supCount === 0) {
      await db.collection('suppliers').insertMany([
        { id: 'S001', supplier_name: '博奥生物', category: '抗原原料', risk_level: 'Low', quality_score: 95.5, certification: 'ISO 13485' },
        { id: 'S002', supplier_name: '华大智造', category: '仪器配件', risk_level: 'Medium', quality_score: 88.0, certification: 'ISO 9001' },
        { id: 'S003', supplier_name: '上海生物制品研究所', category: '标准品', risk_level: 'Low', quality_score: 92.0, certification: 'ISO 13485/GMP' },
      ]);
    }
    const evtCount = await db.collection('quality_events').countDocuments();
    if (evtCount === 0) {
      await db.collection('quality_events').insertMany([
        { id: 'QE001', event_type: 'Deviation', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: 'B202401001', risk_level: 'High', status: 'In Investigation', description: '灌装线温度超限报警，持续15分钟超出规格上限2°C', reported_by: 'qa_engineer', created_at: '2026-07-15T09:30:00Z' },
        { id: 'QE002', event_type: 'OOS', product_id: 'P004', product_name: '新冠抗原检测试剂盒', batch_no: 'B202401050', risk_level: 'Critical', status: 'Open', description: '成品检测项灵敏度指标超出标准范围下限', reported_by: 'qa_engineer', created_at: '2026-07-20T14:00:00Z' },
        { id: 'QE003', event_type: 'Complaint', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: 'B202312120', risk_level: 'Medium', status: 'Closed', description: '客户反馈试剂盒包装破损导致试剂泄漏', reported_by: 'qa_manager', created_at: '2026-06-01T10:00:00Z' },
        { id: 'QE004', event_type: 'Deviation', product_id: 'P002', product_name: '全自动化学发光免疫分析仪', batch_no: 'M202402001', risk_level: 'Medium', status: 'In Investigation', description: '仪器校准参数偏差超过警戒线', reported_by: 'qa_engineer', created_at: '2026-07-25T08:00:00Z' },
        { id: 'QE005', event_type: 'CAPA', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: '', risk_level: 'Low', status: 'Open', description: '内审发现文件控制流程存在缺陷', reported_by: 'qa_manager', created_at: '2026-07-28T16:00:00Z' },
      ]);
    }
    const capaCount = await db.collection('capa_records').countDocuments();
    if (capaCount === 0) {
      await db.collection('capa_records').insertMany([
        { id: 'CAPA001', event_id: 'QE003', title: '包装破损根因纠正', root_cause: '运输过程中外箱承压不足', action_plan: '1)升级外箱材质 2)增加缓冲材料 3)修订包装SOP', status: 'Closed', assignee: '包装工程师', due_date: '2026-07-15', effectiveness: '有效', created_at: '2026-06-05T09:00:00Z' },
        { id: 'CAPA002', event_id: 'QE002', title: 'OOS成品灵敏度异常调查', root_cause: '调查中', action_plan: '待确定根因后制定', status: 'In Progress', assignee: 'QA工程师', due_date: '2026-08-15', effectiveness: '', created_at: '2026-07-21T09:00:00Z' },
      ]);
    }
    const chgCount = await db.collection('change_records').countDocuments();
    if (chgCount === 0) {
      await db.collection('change_records').insertMany([
        { id: 'CHG001', change_type: '工艺变更', product_id: 'P001', risk: 'High', impact: '变更灌装线温度控制参数，可能影响产品稳定性', validation_status: '待验证', status: 'Pending Approval', initiator: '工艺工程师', created_at: '2026-07-10T10:00:00Z' },
        { id: 'CHG002', change_type: '设备变更', product_id: 'P002', risk: 'Medium', impact: '更换仪器校准标准品供应商', validation_status: '已验证', status: 'Approved', initiator: '设备工程师', created_at: '2026-06-20T14:00:00Z' },
      ]);
    }
  }

  // ---- Collection helper ----
  _col(table) {
    if (isConnected) {
      return db.collection(table);
    }
    // JSON fallback
    if (!this.collections[table]) this.collections[table] = [];
    return {
      _isJson: true,
      data: this.collections[table],
      _table: table,
      _db: this,
    };
  }

  _saveJson(name) {
    const fs = require('fs');
    const path = require('path');
    const DB_DIR = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(path.join(DB_DIR, name + '.json'), JSON.stringify(this.collections[name], null, 2), 'utf8');
  }

  // ---- Generic CRUD ----
  findAll(table, filter = {}) {
    if (isConnected) {
      // Build MongoDB filter
      const mongoFilter = {};
      for (const [k, v] of Object.entries(filter)) {
        if (v !== undefined && v !== null && v !== '') {
          if (typeof v === 'object' && v.$gte !== undefined) mongoFilter[k] = { $gte: v.$gte };
          else if (typeof v === 'object' && v.$lte !== undefined) mongoFilter[k] = { $lte: v.$lte };
          else if (typeof v === 'object' && v.$like !== undefined) mongoFilter[k] = { $regex: v.$like, $options: 'i' };
          else mongoFilter[k] = v;
        }
      }
      return db.collection(table).find(mongoFilter).sort({ created_at: -1 }).toArray();
    }
    // JSON fallback - synchronous
    let rows = [...(this.collections[table] || [])];
    for (const [k, v] of Object.entries(filter)) {
      if (v !== undefined && v !== null && v !== '') {
        rows = rows.filter(r => {
          if (typeof v === 'object' && v.$gte !== undefined) return r[k] >= v.$gte;
          if (typeof v === 'object' && v.$lte !== undefined) return r[k] <= v.$lte;
          if (typeof v === 'object' && v.$like !== undefined) return String(r[k] || '').includes(v.$like);
          return r[k] == v;
        });
      }
    }
    rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return rows;
  }

  findById(table, id) {
    if (isConnected) {
      return db.collection(table).findOne({ id: id });
    }
    return (this.collections[table] || []).find(r => r.id === id) || null;
  }

  insert(table, data, username) {
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4().slice(0, 8).toUpperCase();
    const record = { id, ...data, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

    if (isConnected) {
      db.collection(table).insertOne(record);
      this._log('CREATE', table, id, 'Created', username);
      return record;
    }
    // JSON fallback
    if (!this.collections[table]) this.collections[table] = [];
    this.collections[table].push(record);
    this._saveJson(table);
    this._log('CREATE', table, id, 'Created', username);
    return record;
  }

  update(table, id, data, username) {
    if (isConnected) {
      db.collection(table).updateOne(
        { id: id },
        { $set: { ...data, updated_at: new Date().toISOString() } }
      );
      this._log('UPDATE', table, id, JSON.stringify(data).slice(0, 200), username);
      return db.collection(table).findOne({ id: id });
    }
    // JSON fallback
    const idx = (this.collections[table] || []).findIndex(r => r.id === id);
    if (idx === -1) return null;
    this.collections[table][idx] = { ...this.collections[table][idx], ...data, id, updated_at: new Date().toISOString() };
    this._saveJson(table);
    this._log('UPDATE', table, id, JSON.stringify(data).slice(0, 200), username);
    return this.collections[table][idx];
  }

  delete(table, id, username) {
    if (isConnected) {
      db.collection(table).deleteOne({ id: id });
      this._log('DELETE', table, id, 'Deleted', username);
      return true;
    }
    const idx = (this.collections[table] || []).findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.collections[table].splice(idx, 1);
    this._saveJson(table);
    this._log('DELETE', table, id, 'Deleted', username);
    return true;
  }

  count(table, filter = {}) {
    if (isConnected) {
      return db.collection(table).countDocuments(filter);
    }
    return this.findAll(table, filter).length;
  }

  // ---- Audit Log ----
  _log(action, table, recordId, detail, username) {
    const { v4: uuidv4 } = require('uuid');
    const logEntry = {
      id: uuidv4().slice(0, 8),
      action, table_name: table, record_id: recordId,
      detail, timestamp: new Date().toISOString(), user: username || 'system'
    };

    if (isConnected) {
      db.collection('audit_logs').insertOne(logEntry);
      return;
    }
    this.collections.audit_logs.push(logEntry);
    if (this.collections.audit_logs.length > 10000) this.collections.audit_logs = this.collections.audit_logs.slice(-5000);
    this._saveJson('audit_logs');
  }

  getAuditLogs(table, recordId) {
    if (isConnected) {
      return db.collection('audit_logs').find({ table_name: table, record_id: recordId }).toArray();
    }
    return this.collections.audit_logs.filter(l => l.table_name === table && l.record_id === recordId);
  }

  // ---- Dashboard Stats ----
  async getDashboardStats() {
    const events = isConnected 
      ? await db.collection('quality_events').find({}).toArray()
      : this.collections.quality_events || [];
    const capas = isConnected
      ? await db.collection('capa_records').find({}).toArray()
      : this.collections.capa_records || [];
    const changes = isConnected
      ? await db.collection('change_records').find({}).toArray()
      : this.collections.change_records || [];

    return {
      totalEvents: events.length,
      openEvents: events.filter(e => e.status === 'Open' || e.status === 'In Investigation').length,
      closedEvents: events.filter(e => e.status === 'Closed').length,
      totalCAPAs: capas.length,
      openCAPAs: capas.filter(c => c.status === 'Open' || c.status === 'In Progress').length,
      overdueCAPAs: capas.filter(c => c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed').length,
      totalChanges: changes.length,
      pendingChanges: changes.filter(c => c.status === 'Pending Approval').length,
      monthlyTrends: this._getMonthlyTrends(events),
      riskDistribution: {
        Low: events.filter(e => e.risk_level === 'Low').length,
        Medium: events.filter(e => e.risk_level === 'Medium').length,
        High: events.filter(e => e.risk_level === 'High').length,
        Critical: events.filter(e => e.risk_level === 'Critical').length,
      },
      eventTypes: {
        Deviation: events.filter(e => e.event_type === 'Deviation').length,
        OOS: events.filter(e => e.event_type === 'OOS').length,
        Complaint: events.filter(e => e.event_type === 'Complaint').length,
        CAPA: events.filter(e => e.event_type === 'CAPA').length,
        Other: events.filter(e => !['Deviation','OOS','Complaint','CAPA'].includes(e.event_type)).length,
      },
    };
  }

  _getMonthlyTrends(events) {
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      months.push({ month: key, count: events.filter(e => e.created_at && e.created_at.startsWith(key)).length });
    }
    return months;
  }
}

// Singleton
const mongoDb = new MongoDatabase();

// Connect on load
mongoDb.connect().then(() => {
  console.log('🗄️  Database initialized');
}).catch(err => {
  console.error('Database init error:', err.message);
});

module.exports = mongoDb;
