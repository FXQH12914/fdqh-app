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
    
    const tables = ['users', 'products', 'suppliers', 'quality_events', 'capa_records', 'change_records', 'audit_logs', 'documents', 'qcp_library', 'risk_database'];
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

    // ---- QO01: Product Passport (产品质量档案) ----
    if (this.collections.products.length === 0) {
      this.collections.products = [
        { id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', product_category: '试剂', detection_tech: 'CLIA', platform: '化学发光平台', risk_class: 'III', reg_category: '三类', lifecycle_status: '生产', regulatory_status: '已注册', reg_no: '国械注准20243400001', indications: '肝癌辅助诊断', spec_model: '100T/盒', storage_condition: '2-8°C', shelf_life: '12个月', created_at: new Date().toISOString() },
        { id: 'P002', product_name: '全自动化学发光免疫分析仪 (F-i1000)', product_category: '仪器', detection_tech: 'CLIA', platform: '化学发光平台', risk_class: 'II', reg_category: '二类', lifecycle_status: '生产', regulatory_status: '已注册', reg_no: '沪械注准20242000002', throughput: '120T/h', created_at: new Date().toISOString() },
        { id: 'P003', product_name: '血糖检测试剂盒 (GOD法)', product_category: '试剂', detection_tech: 'GOD', platform: '生化平台', risk_class: 'II', reg_category: '二类', lifecycle_status: '研发', regulatory_status: '注册中', reg_no: '', spec_model: '200T/盒', storage_condition: '2-8°C', shelf_life: '18个月', created_at: new Date().toISOString() },
        { id: 'P004', product_name: '新冠抗原检测试剂盒 (胶体金法)', product_category: '试剂', detection_tech: '胶体金', platform: 'POCT平台', risk_class: 'III', reg_category: '三类', lifecycle_status: '生产', regulatory_status: '已注册', reg_no: '国械注准20243400100', spec_model: '25人份/盒', storage_condition: '4-30°C', shelf_life: '18个月', created_at: new Date().toISOString() },
        { id: 'P005', product_name: '梅毒螺旋体抗体检测试剂盒 (ELISA)', product_category: '试剂', detection_tech: 'ELISA', platform: 'ELISA平台', risk_class: 'III', reg_category: '三类', lifecycle_status: '生产', regulatory_status: '已注册', reg_no: '国械注准20233400888', spec_model: '96T/盒', storage_condition: '2-8°C', shelf_life: '12个月', created_at: new Date().toISOString() },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'products.json'), JSON.stringify(this.collections.products, null, 2));
    }
    // ---- QO05: Supplier Quality Profile (供应商质量档案) ----
    if (this.collections.suppliers.length === 0) {
      this.collections.suppliers = [
        { id: 'S001', supplier_name: '博奥生物', supplier_code: 'SUP-BA-001', category: '抗原原料', material_category: '关键原料', risk_level: 'Medium', risk_score: 35, quality_score: 95.5, certification: 'ISO 13485', audit_result: '通过', audit_date: '2026-03-15', incoming_pass_rate: 99.2, scar_count: 1, created_at: new Date().toISOString() },
        { id: 'S002', supplier_name: '华大智造', supplier_code: 'SUP-MGI-001', category: '仪器配件', material_category: '一般物料', risk_level: 'Low', risk_score: 15, quality_score: 88.0, certification: 'ISO 9001', audit_result: '通过', audit_date: '2026-01-20', incoming_pass_rate: 97.8, scar_count: 2, created_at: new Date().toISOString() },
        { id: 'S003', supplier_name: '上海生物制品研究所', supplier_code: 'SUP-SIBP-001', category: '标准品/校准品', material_category: '关键原料', risk_level: 'Low', risk_score: 12, quality_score: 92.0, certification: 'ISO 13485 / GMP', audit_result: '通过', audit_date: '2025-12-10', incoming_pass_rate: 99.8, scar_count: 0, created_at: new Date().toISOString() },
        { id: 'S004', supplier_name: '浙江某包装公司', supplier_code: 'SUP-ZP-001', category: '包材', material_category: '一般物料', risk_level: 'Medium', risk_score: 45, quality_score: 82.0, certification: 'ISO 9001', audit_result: '条件通过', audit_date: '2026-04-05', incoming_pass_rate: 91.5, scar_count: 3, created_at: new Date().toISOString() },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'suppliers.json'), JSON.stringify(this.collections.suppliers, null, 2));
    }
    // ---- QO06: Quality Event Library (质量事件库) ----
    if (this.collections.quality_events.length === 0) {
      this.collections.quality_events = [
        { id: 'QE001', event_code: 'QE-01', event_type: 'Deviation', event_subtype: '工艺偏差', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: 'B202401001', risk_level: 'High', severity: '高', occurrence: '偶发', detectability: '中等', rpn_score: 160, status: 'In Investigation', description: '灌装线温度超限报警，持续15分钟超出规格上限2°C', root_cause_category: '', reported_by: 'qa_engineer', responsible_dept: '生产部', occurred_at: '2026-07-15T09:30:00Z', closed_at: '', created_at: '2026-07-15T09:30:00Z' },
        { id: 'QE002', event_code: 'QE-02', event_type: 'OOS', event_subtype: '成品OOS', product_id: 'P004', product_name: '新冠抗原检测试剂盒 (胶体金法)', batch_no: 'B202401050', risk_level: 'Critical', severity: '严重', occurrence: '罕见', detectability: '低', rpn_score: 240, status: 'Open', description: '成品检测项灵敏度指标超出标准范围下限，CUTOFF值异常偏高', root_cause_category: '', reported_by: 'qa_engineer', responsible_dept: 'QC部', occurred_at: '2026-07-20T14:00:00Z', closed_at: '', created_at: '2026-07-20T14:00:00Z' },
        { id: 'QE003', event_code: 'QE-04', event_type: 'Complaint', event_subtype: '包装投诉', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: 'B202312120', risk_level: 'Medium', severity: '中等', occurrence: '偶发', detectability: '高', rpn_score: 80, status: 'Closed', description: '客户反馈试剂盒包装破损导致试剂泄漏，涉及3盒产品', root_cause_category: '包装设计', reported_by: 'qa_manager', responsible_dept: 'QA部', occurred_at: '2026-06-01T10:00:00Z', closed_at: '2026-07-15', created_at: '2026-06-01T10:00:00Z' },
        { id: 'QE004', event_code: 'QE-01', event_type: 'Deviation', event_subtype: '设备偏差', product_id: 'P002', product_name: '全自动化学发光免疫分析仪 (F-i1000)', batch_no: 'M202402001', risk_level: 'Medium', severity: '中等', occurrence: '偶发', detectability: '中等', rpn_score: 96, status: 'In Investigation', description: '仪器校准参数偏差超过警戒线，光路系统基线漂移+3.5%', root_cause_category: '', reported_by: 'qa_engineer', responsible_dept: '工程部', occurred_at: '2026-07-25T08:00:00Z', closed_at: '', created_at: '2026-07-25T08:00:00Z' },
        { id: 'QE005', event_code: 'QE-05', event_type: 'Audit-Finding', event_subtype: '文件控制', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: '', risk_level: 'Low', severity: '轻微', occurrence: '常见', detectability: '高', rpn_score: 40, status: 'Open', description: '内审发现文件控制流程存在缺陷，SOP版本控制不规范', root_cause_category: '', reported_by: 'qa_manager', responsible_dept: 'QA部', occurred_at: '2026-07-28T16:00:00Z', closed_at: '', created_at: '2026-07-28T16:00:00Z' },
        { id: 'QE006', event_code: 'QE-03', event_type: 'OOT', event_subtype: '稳定性OOT', product_id: 'P005', product_name: '梅毒螺旋体抗体检测试剂盒 (ELISA)', batch_no: 'B202403010', risk_level: 'High', severity: '高', occurrence: '罕见', detectability: '低', rpn_score: 180, status: 'Open', description: '37°C加速稳定性试验第14天灵敏度指标出现异常下降趋势', root_cause_category: '', reported_by: 'qa_manager', responsible_dept: '研发部', occurred_at: '2026-07-30T11:00:00Z', closed_at: '', created_at: '2026-07-30T11:00:00Z' },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'quality_events.json'), JSON.stringify(this.collections.quality_events, null, 2));
    }
    // ---- QO07: CAPA Knowledge Base (CAPA知识库) ----
    if (this.collections.capa_records.length === 0) {
      this.collections.capa_records = [
        { id: 'CAPA001', event_id: 'QE003', title: '包装破损根因纠正', defect_mode: '外箱承压不足', root_cause_category: '包装设计', root_cause: '运输过程中外箱承压不足，跌落测试裕度不够', corrective_action: '1) 升级外箱材质为双瓦楞 2) 增加EPE缓冲衬垫 3) 修订包装SOP (SOP-PKG-003)', preventive_action: '1) 对全品类产品包装进行承压/跌落验证 2) 建立包材IQC标准 3) 增加运输模拟测试环节', status: 'Closed', assignee: '包装工程师', due_date: '2026-07-15', effectiveness: '有效', verified_by: 'qa_manager', verified_date: '2026-07-20', created_at: '2026-06-05T09:00:00Z' },
        { id: 'CAPA002', event_id: 'QE002', title: 'OOS成品灵敏度异常调查', defect_mode: 'CUTOFF值异常偏高', root_cause_category: '', root_cause: '调查中 - 初步排除设备故障，怀疑原料批次差异', corrective_action: '1) 隔离疑似批次 2) 启动原料追溯 3) 复检保留样品', preventive_action: '待确定根因后制定', status: 'In Progress', assignee: 'QC工程师', due_date: '2026-08-15', effectiveness: '', verified_by: '', verified_date: '', created_at: '2026-07-21T09:00:00Z' },
        { id: 'CAPA003', event_id: 'QE001', title: '灌装线温度偏差CAPA', defect_mode: '温度控制超限', root_cause_category: '设备老化', root_cause: '灌装线温控模块传感器老化导致精度漂移', corrective_action: '1) 更换温度传感器模组 2) 校准验证 3) 增加温度监控频率', preventive_action: '1) 建立关键设备传感器定期校准计划 2) 增加温度超限自动报警阈值 3) 修订设备预防性维护SOP', status: 'Open', assignee: '设备工程师', due_date: '2026-08-10', effectiveness: '', verified_by: '', verified_date: '', created_at: '2026-07-16T10:00:00Z' },
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
    // ---- QO08: Quality Control Point Library (质量控制点库) ----
    if (this.collections.qcp_library && this.collections.qcp_library.length === 0) {
      this.collections.qcp_library = [
        { id: 'QCP001', qcp_code: 'QCP-ELISA-001', name: '包被过程控制', stage: '生产', risk_level: 'High', control_purpose: '确保抗原包被浓度和均一性', key_param: '抗原浓度', spec_standard: '±5%', alert_rule: '超限触发偏差', detection_method: 'ELISA读数', frequency: '每批', product_category: 'ELISA试剂', created_at: new Date().toISOString() },
        { id: 'QCP002', qcp_code: 'QCP-ELISA-002', name: '封闭过程控制', stage: '生产', risk_level: 'Medium', control_purpose: '防止非特异性结合', key_param: '封闭液浓度', spec_standard: '±3%', alert_rule: '超限触发偏差', detection_method: 'OD值检测', frequency: '每批', product_category: 'ELISA试剂', created_at: new Date().toISOString() },
        { id: 'QCP003', qcp_code: 'QCP-CLIA-001', name: '磁珠包被控制', stage: '生产', risk_level: 'High', control_purpose: '确保磁珠偶联效率', key_param: '偶联率', spec_standard: '≥85%', alert_rule: '<80%触发偏差', detection_method: 'BCA法', frequency: '每批', product_category: 'CLIA试剂', created_at: new Date().toISOString() },
        { id: 'QCP004', qcp_code: 'QCP-ALL-001', name: '来料检验控制', stage: '供应链', risk_level: 'High', control_purpose: '确保原料质量符合标准', key_param: '原料COA', spec_standard: '按COA标准', alert_rule: '不合格触发退货', detection_method: 'QC检验', frequency: '每批来料', product_category: '全部', created_at: new Date().toISOString() },
        { id: 'QCP005', qcp_code: 'QCP-ALL-002', name: '成品放行检验', stage: '放行', risk_level: 'Critical', control_purpose: '确保成品质量符合注册标准', key_param: '全项检测', spec_standard: '按注册标准', alert_rule: '任一不合格禁止放行', detection_method: 'QC全检', frequency: '每批', product_category: '全部', created_at: new Date().toISOString() },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'qcp_library.json'), JSON.stringify(this.collections.qcp_library, null, 2));
    }
    // ---- QO09: Risk Database (风险数据库) ----
    if (this.collections.risk_database && this.collections.risk_database.length === 0) {
      this.collections.risk_database = [
        { id: 'RSK001', risk_code: 'RSK-CLIA-001', hazard: '包被浓度偏差导致灵敏度下降', severity: '高', probability: '低', detectability: '中等', risk_level: 'Medium', rpn: 96, fmea_type: 'PFMEA', product_id: 'P001', control_measure: '包被过程QCP监控', status: '已控', created_at: new Date().toISOString() },
        { id: 'RSK002', risk_code: 'RSK-CLIA-002', hazard: '温控系统故障导致产品稳定性受影响', severity: '严重', probability: '低', detectability: '高', risk_level: 'High', rpn: 112, fmea_type: 'PFMEA', product_id: 'P001', control_measure: '温度实时监控+报警', status: '已控', created_at: new Date().toISOString() },
        { id: 'RSK003', risk_code: 'RSK-ALL-001', hazard: '供应商原料批次差异导致成品性能波动', severity: '严重', probability: '中等', detectability: '中等', risk_level: 'High', rpn: 180, fmea_type: 'DFMEA', product_id: '', control_measure: '供应商管理+来料检验', status: '监控中', created_at: new Date().toISOString() },
      ];
      fs.writeFileSync(path.join(DB_DIR, 'risk_database.json'), JSON.stringify(this.collections.risk_database, null, 2));
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

    // QO01: Product Passport
    const prodCount = await db.collection('products').countDocuments();
    if (prodCount === 0) {
      await db.collection('products').insertMany([
        { id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', product_category: '试剂', detection_tech: 'CLIA', platform: '化学发光平台', risk_class: 'III', reg_category: '三类', lifecycle_status: '生产', regulatory_status: '已注册', reg_no: '国械注准20243400001', indications: '肝癌辅助诊断', spec_model: '100T/盒', storage_condition: '2-8°C', shelf_life: '12个月', created_at: new Date().toISOString() },
        { id: 'P002', product_name: '全自动化学发光免疫分析仪 (F-i1000)', product_category: '仪器', detection_tech: 'CLIA', platform: '化学发光平台', risk_class: 'II', reg_category: '二类', lifecycle_status: '生产', regulatory_status: '已注册', reg_no: '沪械注准20242000002', throughput: '120T/h', created_at: new Date().toISOString() },
        { id: 'P003', product_name: '血糖检测试剂盒 (GOD法)', product_category: '试剂', detection_tech: 'GOD', platform: '生化平台', risk_class: 'II', reg_category: '二类', lifecycle_status: '研发', regulatory_status: '注册中', reg_no: '', spec_model: '200T/盒', storage_condition: '2-8°C', shelf_life: '18个月', created_at: new Date().toISOString() },
        { id: 'P004', product_name: '新冠抗原检测试剂盒 (胶体金法)', product_category: '试剂', detection_tech: '胶体金', platform: 'POCT平台', risk_class: 'III', reg_category: '三类', lifecycle_status: '生产', regulatory_status: '已注册', reg_no: '国械注准20243400100', spec_model: '25人份/盒', storage_condition: '4-30°C', shelf_life: '18个月', created_at: new Date().toISOString() },
        { id: 'P005', product_name: '梅毒螺旋体抗体检测试剂盒 (ELISA)', product_category: '试剂', detection_tech: 'ELISA', platform: 'ELISA平台', risk_class: 'III', reg_category: '三类', lifecycle_status: '生产', regulatory_status: '已注册', reg_no: '国械注准20233400888', spec_model: '96T/盒', storage_condition: '2-8°C', shelf_life: '12个月', created_at: new Date().toISOString() },
      ]);
    }
    // QO05: Supplier Quality Profile
    const supCount = await db.collection('suppliers').countDocuments();
    if (supCount === 0) {
      await db.collection('suppliers').insertMany([
        { id: 'S001', supplier_name: '博奥生物', supplier_code: 'SUP-BA-001', category: '抗原原料', material_category: '关键原料', risk_level: 'Medium', risk_score: 35, quality_score: 95.5, certification: 'ISO 13485', audit_result: '通过', audit_date: '2026-03-15', incoming_pass_rate: 99.2, scar_count: 1, created_at: new Date().toISOString() },
        { id: 'S002', supplier_name: '华大智造', supplier_code: 'SUP-MGI-001', category: '仪器配件', material_category: '一般物料', risk_level: 'Low', risk_score: 15, quality_score: 88.0, certification: 'ISO 9001', audit_result: '通过', audit_date: '2026-01-20', incoming_pass_rate: 97.8, scar_count: 2, created_at: new Date().toISOString() },
        { id: 'S003', supplier_name: '上海生物制品研究所', supplier_code: 'SUP-SIBP-001', category: '标准品/校准品', material_category: '关键原料', risk_level: 'Low', risk_score: 12, quality_score: 92.0, certification: 'ISO 13485 / GMP', audit_result: '通过', audit_date: '2025-12-10', incoming_pass_rate: 99.8, scar_count: 0, created_at: new Date().toISOString() },
        { id: 'S004', supplier_name: '浙江某包装公司', supplier_code: 'SUP-ZP-001', category: '包材', material_category: '一般物料', risk_level: 'Medium', risk_score: 45, quality_score: 82.0, certification: 'ISO 9001', audit_result: '条件通过', audit_date: '2026-04-05', incoming_pass_rate: 91.5, scar_count: 3, created_at: new Date().toISOString() },
      ]);
    }
    // QO06: Quality Event Library
    const evtCount = await db.collection('quality_events').countDocuments();
    if (evtCount === 0) {
      await db.collection('quality_events').insertMany([
        { id: 'QE001', event_code: 'QE-01', event_type: 'Deviation', event_subtype: '工艺偏差', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: 'B202401001', risk_level: 'High', severity: '高', occurrence: '偶发', detectability: '中等', rpn_score: 160, status: 'In Investigation', description: '灌装线温度超限报警，持续15分钟超出规格上限2°C', root_cause_category: '', reported_by: 'qa_engineer', responsible_dept: '生产部', occurred_at: '2026-07-15T09:30:00Z', closed_at: '', created_at: '2026-07-15T09:30:00Z' },
        { id: 'QE002', event_code: 'QE-02', event_type: 'OOS', event_subtype: '成品OOS', product_id: 'P004', product_name: '新冠抗原检测试剂盒 (胶体金法)', batch_no: 'B202401050', risk_level: 'Critical', severity: '严重', occurrence: '罕见', detectability: '低', rpn_score: 240, status: 'Open', description: '成品检测项灵敏度指标超出标准范围下限，CUTOFF值异常偏高', root_cause_category: '', reported_by: 'qa_engineer', responsible_dept: 'QC部', occurred_at: '2026-07-20T14:00:00Z', closed_at: '', created_at: '2026-07-20T14:00:00Z' },
        { id: 'QE003', event_code: 'QE-04', event_type: 'Complaint', event_subtype: '包装投诉', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: 'B202312120', risk_level: 'Medium', severity: '中等', occurrence: '偶发', detectability: '高', rpn_score: 80, status: 'Closed', description: '客户反馈试剂盒包装破损导致试剂泄漏，涉及3盒产品', root_cause_category: '包装设计', reported_by: 'qa_manager', responsible_dept: 'QA部', occurred_at: '2026-06-01T10:00:00Z', closed_at: '2026-07-15', created_at: '2026-06-01T10:00:00Z' },
        { id: 'QE004', event_code: 'QE-01', event_type: 'Deviation', event_subtype: '设备偏差', product_id: 'P002', product_name: '全自动化学发光免疫分析仪 (F-i1000)', batch_no: 'M202402001', risk_level: 'Medium', severity: '中等', occurrence: '偶发', detectability: '中等', rpn_score: 96, status: 'In Investigation', description: '仪器校准参数偏差超过警戒线，光路系统基线漂移+3.5%', root_cause_category: '', reported_by: 'qa_engineer', responsible_dept: '工程部', occurred_at: '2026-07-25T08:00:00Z', closed_at: '', created_at: '2026-07-25T08:00:00Z' },
        { id: 'QE005', event_code: 'QE-05', event_type: 'Audit-Finding', event_subtype: '文件控制', product_id: 'P001', product_name: '化学发光免疫分析试剂盒 (AFP)', batch_no: '', risk_level: 'Low', severity: '轻微', occurrence: '常见', detectability: '高', rpn_score: 40, status: 'Open', description: '内审发现文件控制流程存在缺陷，SOP版本控制不规范', root_cause_category: '', reported_by: 'qa_manager', responsible_dept: 'QA部', occurred_at: '2026-07-28T16:00:00Z', closed_at: '', created_at: '2026-07-28T16:00:00Z' },
        { id: 'QE006', event_code: 'QE-03', event_type: 'OOT', event_subtype: '稳定性OOT', product_id: 'P005', product_name: '梅毒螺旋体抗体检测试剂盒 (ELISA)', batch_no: 'B202403010', risk_level: 'High', severity: '高', occurrence: '罕见', detectability: '低', rpn_score: 180, status: 'Open', description: '37°C加速稳定性试验第14天灵敏度指标出现异常下降趋势', root_cause_category: '', reported_by: 'qa_manager', responsible_dept: '研发部', occurred_at: '2026-07-30T11:00:00Z', closed_at: '', created_at: '2026-07-30T11:00:00Z' },
      ]);
    }
    // QO07: CAPA Knowledge Base
    const capaCount = await db.collection('capa_records').countDocuments();
    if (capaCount === 0) {
      await db.collection('capa_records').insertMany([
        { id: 'CAPA001', event_id: 'QE003', title: '包装破损根因纠正', defect_mode: '外箱承压不足', root_cause_category: '包装设计', root_cause: '运输过程中外箱承压不足，跌落测试裕度不够', corrective_action: '1) 升级外箱材质为双瓦楞 2) 增加EPE缓冲衬垫 3) 修订包装SOP (SOP-PKG-003)', preventive_action: '1) 对全品类产品包装进行承压/跌落验证 2) 建立包材IQC标准 3) 增加运输模拟测试环节', status: 'Closed', assignee: '包装工程师', due_date: '2026-07-15', effectiveness: '有效', verified_by: 'qa_manager', verified_date: '2026-07-20', created_at: '2026-06-05T09:00:00Z' },
        { id: 'CAPA002', event_id: 'QE002', title: 'OOS成品灵敏度异常调查', defect_mode: 'CUTOFF值异常偏高', root_cause_category: '', root_cause: '调查中 - 初步排除设备故障，怀疑原料批次差异', corrective_action: '1) 隔离疑似批次 2) 启动原料追溯 3) 复检保留样品', preventive_action: '待确定根因后制定', status: 'In Progress', assignee: 'QC工程师', due_date: '2026-08-15', effectiveness: '', verified_by: '', verified_date: '', created_at: '2026-07-21T09:00:00Z' },
        { id: 'CAPA003', event_id: 'QE001', title: '灌装线温度偏差CAPA', defect_mode: '温度控制超限', root_cause_category: '设备老化', root_cause: '灌装线温控模块传感器老化导致精度漂移', corrective_action: '1) 更换温度传感器模组 2) 校准验证 3) 增加温度监控频率', preventive_action: '1) 建立关键设备传感器定期校准计划 2) 增加温度超限自动报警阈值 3) 修订设备预防性维护SOP', status: 'Open', assignee: '设备工程师', due_date: '2026-08-10', effectiveness: '', verified_by: '', verified_date: '', created_at: '2026-07-16T10:00:00Z' },
      ]);
    }
    const chgCount = await db.collection('change_records').countDocuments();
    if (chgCount === 0) {
      await db.collection('change_records').insertMany([
        { id: 'CHG001', change_type: '工艺变更', product_id: 'P001', risk: 'High', impact: '变更灌装线温度控制参数，可能影响产品稳定性', validation_status: '待验证', status: 'Pending Approval', initiator: '工艺工程师', created_at: '2026-07-10T10:00:00Z' },
        { id: 'CHG002', change_type: '设备变更', product_id: 'P002', risk: 'Medium', impact: '更换仪器校准标准品供应商', validation_status: '已验证', status: 'Approved', initiator: '设备工程师', created_at: '2026-06-20T14:00:00Z' },
      ]);
    }
    // QO08: Quality Control Point Library
    const qcpCount = await db.collection('qcp_library').countDocuments();
    if (qcpCount === 0) {
      await db.collection('qcp_library').insertMany([
        { id: 'QCP001', qcp_code: 'QCP-ELISA-001', name: '包被过程控制', stage: '生产', risk_level: 'High', control_purpose: '确保抗原包被浓度和均一性', key_param: '抗原浓度', spec_standard: '±5%', alert_rule: '超限触发偏差', detection_method: 'ELISA读数', frequency: '每批', product_category: 'ELISA试剂', created_at: new Date().toISOString() },
        { id: 'QCP002', qcp_code: 'QCP-ELISA-002', name: '封闭过程控制', stage: '生产', risk_level: 'Medium', control_purpose: '防止非特异性结合', key_param: '封闭液浓度', spec_standard: '±3%', alert_rule: '超限触发偏差', detection_method: 'OD值检测', frequency: '每批', product_category: 'ELISA试剂', created_at: new Date().toISOString() },
        { id: 'QCP003', qcp_code: 'QCP-CLIA-001', name: '磁珠包被控制', stage: '生产', risk_level: 'High', control_purpose: '确保磁珠偶联效率', key_param: '偶联率', spec_standard: '≥85%', alert_rule: '<80%触发偏差', detection_method: 'BCA法', frequency: '每批', product_category: 'CLIA试剂', created_at: new Date().toISOString() },
        { id: 'QCP004', qcp_code: 'QCP-ALL-001', name: '来料检验控制', stage: '供应链', risk_level: 'High', control_purpose: '确保原料质量符合标准', key_param: '原料COA', spec_standard: '按COA标准', alert_rule: '不合格触发退货', detection_method: 'QC检验', frequency: '每批来料', product_category: '全部', created_at: new Date().toISOString() },
        { id: 'QCP005', qcp_code: 'QCP-ALL-002', name: '成品放行检验', stage: '放行', risk_level: 'Critical', control_purpose: '确保成品质量符合注册标准', key_param: '全项检测', spec_standard: '按注册标准', alert_rule: '任一不合格禁止放行', detection_method: 'QC全检', frequency: '每批', product_category: '全部', created_at: new Date().toISOString() },
      ]);
    }
    // QO09: Risk Database
    const rskCount = await db.collection('risk_database').countDocuments();
    if (rskCount === 0) {
      await db.collection('risk_database').insertMany([
        { id: 'RSK001', risk_code: 'RSK-CLIA-001', hazard: '包被浓度偏差导致灵敏度下降', severity: '高', probability: '低', detectability: '中等', risk_level: 'Medium', rpn: 96, fmea_type: 'PFMEA', product_id: 'P001', control_measure: '包被过程QCP监控', status: '已控', created_at: new Date().toISOString() },
        { id: 'RSK002', risk_code: 'RSK-CLIA-002', hazard: '温控系统故障导致产品稳定性受影响', severity: '严重', probability: '低', detectability: '高', risk_level: 'High', rpn: 112, fmea_type: 'PFMEA', product_id: 'P001', control_measure: '温度实时监控+报警', status: '已控', created_at: new Date().toISOString() },
        { id: 'RSK003', risk_code: 'RSK-ALL-001', hazard: '供应商原料批次差异导致成品性能波动', severity: '严重', probability: '中等', detectability: '中等', risk_level: 'High', rpn: 180, fmea_type: 'DFMEA', product_id: '', control_measure: '供应商管理+来料检验', status: '监控中', created_at: new Date().toISOString() },
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
    const risks = isConnected
      ? await db.collection('risk_database').find({}).toArray()
      : this.collections.risk_database || [];
    const qcps = isConnected
      ? await db.collection('qcp_library').find({}).toArray()
      : this.collections.qcp_library || [];

    return {
      totalEvents: events.length,
      openEvents: events.filter(e => e.status === 'Open' || e.status === 'In Investigation').length,
      closedEvents: events.filter(e => e.status === 'Closed').length,
      totalCAPAs: capas.length,
      openCAPAs: capas.filter(c => c.status === 'Open' || c.status === 'In Progress').length,
      overdueCAPAs: capas.filter(c => c.due_date && new Date(c.due_date) < new Date() && c.status !== 'Closed').length,
      totalChanges: changes.length,
      pendingChanges: changes.filter(c => c.status === 'Pending Approval').length,
      totalRisks: risks.length,
      highRisks: risks.filter(r => r.risk_level === 'High' || r.risk_level === 'Critical').length,
      totalQCPs: qcps.length,
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
        OOT: events.filter(e => e.event_type === 'OOT').length,
        Other: events.filter(e => !['Deviation','OOS','Complaint','CAPA','OOT','Audit-Finding'].includes(e.event_type)).length,
      },
      riskMatrix: {
        highRisks: risks.filter(r => r.risk_level === 'High').length,
        mediumRisks: risks.filter(r => r.risk_level === 'Medium').length,
        lowRisks: risks.filter(r => r.risk_level === 'Low').length,
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
