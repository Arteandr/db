import * as SequelizeLib from 'sequelize';

export default class DbPlugin extends SequelizeLib.Sequelize {
  henta: any;
  markedASave: Set<unknown>;
  markASave: () => void;
  op: any;
  types: any;

  constructor(henta) {
    // eslint-disable-next-line object-curly-newline
    if (typeof henta.config.private.database === 'object') {
      henta.warning('private.json > database должен быть строкой');
      const { name, user, pass, options } = henta.config.private.database;
      super(name, user, pass, options);
    } else {
      super(henta.config.private.database, {
        logging: henta.config.public.dbLogging ? henta.log : false,
        define: {
          client_encoding: 'UTF8',
          charset: 'utf8mb4'
        },
        pool: {
          max: 5,
          idle: 30000,
          acquire: 60000,
        }
      } as any);
    }

    if (this['options']['dialect'] === 'postgres') {
      this['dialect'].connectionManager.lib.defaults.parseInt8 = true;
    }
    this.henta = henta;
    this.op = SequelizeLib['default'].Op;
    this.types = SequelizeLib['default'].DataTypes;

    const markedASave = new Set();
    function markASave() {
      if (this.$forceSaves.find(v => this.changed(v))) {
        this.$save();
        return;
      }

      markedASave.add(this);
    }

    this.markedASave = markedASave;
    this.markASave = markASave;
  }

  async preInit(henta) {
    try {
      await super.authenticate();
      henta.log('База данных успешно подключена.');

      setInterval(() => this.saveAllData(), 60000);
      henta.onShutdown(() => this.saveAllData());
    } catch (err) {
      throw Error(`Ошибка авторизации в базе данных (${err.message})`);
    }
  }

  async add(slug, model, settings) {
    const definedModel = this.define(slug, model, settings || { timestamps: false });
    await this.safeSync(definedModel);
    return definedModel;
  }

  applySaveCenter(modelPrototype, forceSaves = []) {
    modelPrototype.$forceSaves = forceSaves;
    modelPrototype.$save = modelPrototype.save;
    modelPrototype.save = this.markASave;
  }

  async saveAllData() {
    const savesArray = Array.from(this.markedASave).filter(v => !!v['changed']());
    this.markedASave.clear();
    if (savesArray.length === 0) {
      return;
    }

    this.henta.log(`Сохранение информации в БД (${savesArray.length} шт.)...`);
    await Promise.all(savesArray.map(v => v['$save']()));
  }

  async safeSync(model) {
    // TODO: REWRITE

    await model.sync();
    const { options } = model;
    const queryInterface = this.getQueryInterface();
    const tableName = model.getTableName(options);

    const columns = await queryInterface.describeTable(tableName);

    for (const columnName of Object.keys(model.tableAttributes)) {
      if (columns[columnName]) continue;

      const answer = await this.henta.cmd.questionYN(`Добавить "${columnName}" в таблицу "${tableName}"`);
      if (answer) {
        this.henta.log(`Добавляю "${columnName}" в таблицу "${tableName}"...`);
        await queryInterface.addColumn(tableName, columnName, model.tableAttributes[columnName]);
      } else {
        this.henta.logger.log('Пропускаю...');
      }
    }

    for (const columnName of Object.keys(columns)) {
      if (model.tableAttributes[columnName]) continue;

      const answer = await this.henta.cmd.questionYN(`Удалить "${columnName}" из таблицы "${tableName}"`);
      if (answer) {
        this.henta.log(`Удаляю "${columnName}" из таблицы "${tableName}"...`);
        await queryInterface.removeColumn(tableName, columnName, options);
      } else {
        this.henta.logger.log('Пропускаю...');
      }
    }
  }
}
