"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Model = void 0;
/*
    Model.js - DynamoDB model class

    A model represents a DynamoDB single-table entity.
*/
const Expression_js_1 = require("./Expression.js");
const Error_js_1 = require("./Error.js");
/*
    Ready / write tags for interceptions
 */
const ReadWrite = {
    delete: 'write',
    get: 'read',
    find: 'read',
    put: 'write',
    scan: 'read',
    update: 'write'
};
const TransformParseResponseAs = {
    delete: 'get',
    get: 'get',
    find: 'find',
    put: 'get',
    scan: 'scan',
    update: 'get'
};
const KeysOnly = { delete: true, get: true };
const TransactOps = { delete: 'Delete', get: 'Get', put: 'Put', update: 'Update' };
const BatchOps = { delete: 'DeleteRequest', put: 'PutRequest', update: 'PutRequest' };
const ValidTypes = ['array', 'arraybuffer', 'binary', 'boolean', 'buffer', 'date', 'number', 'object', 'set', 'string'];
const SanityPages = 1000;
const FollowThreads = 10;
class Model {
    /*
        @param table Instance of Table.
        @param name Name of the model.
        @param options Hash of options.
     */
    constructor(table, name, options = {}) {
        if (!table) {
            throw new Error_js_1.OneTableArgError('Missing table argument');
        }
        if (!table.typeField) {
            throw new Error_js_1.OneTableArgError('Invalid table instance');
        }
        if (!name) {
            throw new Error_js_1.OneTableArgError('Missing name of model');
        }
        this.table = table;
        this.name = name;
        this.options = options;
        //  Primary hash and sort attributes and properties
        this.hash = null;
        this.sort = null;
        //  Cache table properties
        this.createdField = table.createdField;
        this.generic = options.generic;
        this.nested = false;
        this.nulls = table.nulls;
        this.tableName = table.name;
        this.typeField = options.typeField || table.typeField;
        this.generic = options.generic != null ? options.generic : table.generic;
        this.timestamps = options.timestamps;
        if (this.timestamps == null) {
            this.timestamps = table.timestamps;
        }
        this.updatedField = table.updatedField;
        this.block = { fields: {}, deps: [] };
        /*
            Map Javascript API properties to DynamoDB attribute names. The schema fields
            map property may contain a '.' like 'obj.prop' to pack multiple properties into a single attribute.
            field.attribute = [attributeName, optional-sub-propertiy]
        */
        this.mappings = {};
        this.schema = table.schema;
        this.indexes = this.schema.indexes;
        if (!this.indexes) {
            throw new Error_js_1.OneTableArgError('Indexes must be defined on the Table before creating models');
        }
        this.indexProperties = this.getIndexProperties(this.indexes);
        let fields = options.fields || this.schema.definition.models[this.name];
        if (fields) {
            this.prepModel(fields, this.block);
        }
    }
    /*
        Prepare a model based on the schema and compute the attribute mapping.
     */
    prepModel(schemaFields, block, prefix = '') {
        let { fields } = block;
        schemaFields = this.table.assign({}, schemaFields);
        if (!prefix) {
            //  Top level only
            if (!schemaFields[this.typeField]) {
                schemaFields[this.typeField] = { type: String, hidden: true };
                if (!this.generic) {
                    schemaFields[this.typeField].required = true;
                }
            }
            if (this.timestamps === true || this.timestamps == 'create') {
                schemaFields[this.createdField] = schemaFields[this.createdField] || { type: 'date' };
            }
            if (this.timestamps === true || this.timestamps == 'update') {
                schemaFields[this.updatedField] = schemaFields[this.updatedField] || { type: 'date' };
            }
        }
        let { indexes, table } = this;
        let primary = indexes.primary;
        //  Attributes that are mapped to a different attribute. Indexed by attribute name for this block.
        let mapTargets = {};
        let map = {};
        for (let [name, field] of Object.entries(schemaFields)) {
            let pathname = prefix ? `${prefix}.${name}` : name;
            if (!field.type) {
                field.type = 'string';
                this.table.log.error(`Missing type field for ${pathname}`, { field });
                // throw new OneTableArgError(`Missing field type for ${pathname}`)
            }
            field.pathname = pathname;
            field.name = name;
            fields[name] = field;
            field.isoDates = field.isoDates != null ? field.isoDates : table.isoDates;
            //  DEPRECATE 2.3
            if (field.uuid) {
                console.warn('The "uuid" schema property is deprecated. Please use "generate": "uuid or ulid" instead');
                field.generate = field.generate || field.uuid;
            }
            field.type = this.checkType(field);
            /*
                Handle mapped attributes. May be packed also (obj.prop)
            */
            let to = field.map;
            if (to) {
                let [att, sub] = to.split('.');
                mapTargets[att] = mapTargets[att] || [];
                if (sub) {
                    if (map[name] && !Array.isArray(map[name])) {
                        throw new Error_js_1.OneTableArgError(`Map already defined as literal for ${this.name}.${name}`);
                    }
                    field.attribute = map[name] = [att, sub];
                    if (mapTargets[att].indexOf(sub) >= 0) {
                        throw new Error_js_1.OneTableArgError(`Multiple attributes in ${this.pathname} mapped to the target ${to}`);
                    }
                    mapTargets[att].push(sub);
                }
                else {
                    if (mapTargets[att].length > 1) {
                        throw new Error_js_1.OneTableArgError(`Multiple attributes in ${this.name} mapped to the target ${to}`);
                    }
                    field.attribute = map[name] = [att];
                    mapTargets[att].push(true);
                }
            }
            else {
                field.attribute = map[name] = [name];
            }
            if (field.nulls !== true && field.nulls !== false) {
                field.nulls = this.nulls;
            }
            /*
                Handle index requirements
            */
            let index = this.indexProperties[field.attribute[0]];
            if (index && !prefix) {
                field.isIndexed = true;
                if (field.attribute.length > 1) {
                    throw new Error_js_1.OneTableArgError(`Cannot map property "${pathname}" to a compound attribute "${this.name}.${pathname}"`);
                }
                if (index == 'primary') {
                    field.required = true;
                    let attribute = field.attribute[0];
                    if (attribute == primary.hash) {
                        this.hash = attribute;
                    }
                    else if (attribute == primary.sort) {
                        this.sort = attribute;
                    }
                }
            }
            if (field.value) {
                //  Value template properties are hidden by default
                if (field.hidden == null) {
                    field.hidden = table.hidden != null ? table.hidden : true;
                }
            }
            /*
                Handle nested schema (recursive)
            */
            if (field.schema) {
                if (field.type == 'array') {
                    throw new Error_js_1.OneTableArgError(`Array types do not (yet) support nested schemas for field "${field.name}" in model "${this.name}"`);
                }
                if (field.type == 'object') {
                    field.block = { deps: [], fields: {} };
                    this.prepModel(field.schema, field.block, name);
                    //  FUTURE - better to apply this to the field block
                    this.nested = true;
                }
                else {
                    throw new Error_js_1.OneTableArgError(`Nested scheme not supported "${field.type}" types for field "${field.name}" in model "${this.name}"`);
                }
            }
        }
        if (Object.values(fields).find(f => f.unique && f.attribute != this.hash && f.attribute != this.sort)) {
            this.hasUniqueFields = true;
        }
        this.mappings = mapTargets;
        /*
            Order the fields so value templates can depend on each other safely
        */
        for (let field of Object.values(fields)) {
            this.orderFields(block, field);
        }
    }
    checkType(field) {
        let type = field.type;
        if (typeof type == 'function') {
            type = type.name;
        }
        type = type.toLowerCase();
        if (ValidTypes.indexOf(type) < 0) {
            throw new Error_js_1.OneTableArgError(`Unknown type "${type}" for field "${field.name}" in model "${this.name}"`);
        }
        return type;
    }
    orderFields(block, field) {
        let { deps, fields } = block;
        if (deps.find(i => i.name == field.pathname)) {
            return;
        }
        if (field.value) {
            let vars = this.table.getVars(field.value);
            for (let pathname of vars) {
                let name = pathname.split('.').shift();
                let ref = fields[name];
                if (ref && ref != field) {
                    if (ref.schema) {
                        this.orderFields(ref.block, ref);
                    }
                    else if (ref.value) {
                        this.orderFields(block, ref);
                    }
                }
            }
        }
        deps.push(field);
    }
    getPropValue(properties, path) {
        let v = properties;
        for (let part of path.split('.')) {
            v = v[part];
        }
        return v;
    }
    /*
        Run an operation on DynamodDB. The command has been parsed via Expression.
        Returns [] for find/scan, cmd if !execute, else returns item.
     */
    run(op, expression) {
        return __awaiter(this, void 0, void 0, function* () {
            let { index, properties, params } = expression;
            //  UNDOCUMENTED AND DEPRECATED
            if (params.preFormat) {
                params.preFormat(this, expression);
            }
            /*
                Get a string representation of the API request
             */
            let cmd = expression.command();
            if (!expression.execute) {
                if (params.log !== false) {
                    this.table.log[params.log ? 'info' : 'data'](`OneTable command for "${op}" "${this.name} (not executed)"`, {
                        cmd, op, properties, params,
                    });
                }
                return cmd;
            }
            /*
                Transactions save the command in params.transaction and wait for db.transaction() to be called.
             */
            let t = params.transaction;
            if (t) {
                if (params.batch) {
                    throw new Error_js_1.OneTableArgError('Cannot have batched transactions');
                }
                let top = TransactOps[op];
                if (top) {
                    params.expression = expression;
                    let items = t.TransactItems = t.TransactItems || [];
                    items.push({ [top]: cmd });
                    return this.transformReadItem(op, properties, properties, params);
                }
                else {
                    throw new Error_js_1.OneTableArgError(`Unknown transaction operation ${op}`);
                }
            }
            /*
                Batch operations save the command in params.transaction and wait for db.batchGet|batchWrite to be called.
             */
            let b = params.batch;
            if (b) {
                params.expression = expression;
                let ritems = b.RequestItems = b.RequestItems || {};
                if (op == 'get') {
                    let list = ritems[this.tableName] = ritems[this.tableName] || { Keys: [] };
                    list.Keys.push(cmd.Keys);
                    return this.transformReadItem(op, properties, properties, params);
                }
                else {
                    let list = ritems[this.tableName] = ritems[this.tableName] || [];
                    let bop = BatchOps[op];
                    list.push({ [bop]: cmd });
                    return this.transformReadItem(op, properties, properties, params);
                }
            }
            /*
                Prep the stats
            */
            let stats = params.stats;
            if (stats && typeof params == 'object') {
                stats.count = stats.count || 0;
                stats.scanned = stats.capacity || 0;
                stats.capacity = stats.capacity || 0;
            }
            /*
                Run command. Paginate if required.
             */
            let pages = 0, items = [];
            let maxPages = params.maxPages ? params.maxPages : SanityPages;
            let result;
            do {
                result = yield this.table.execute(this.name, op, cmd, properties, params);
                if (result.LastEvaluatedKey) {
                    //  Continue next page
                    cmd.ExclusiveStartKey = result.LastEvaluatedKey;
                }
                if (result.Items) {
                    items = items.concat(result.Items);
                    if (stats) {
                        stats.count += result.Count;
                        stats.scanned += result.ScannedCount;
                        if (result.ConsumedCapacity) {
                            stats.capacity += result.ConsumedCapacity.CapacityUnits;
                        }
                    }
                }
                else if (result.Item) {
                    items = [result.Item];
                    break;
                }
                else if (result.Attributes) {
                    items = [result.Attributes];
                    break;
                }
                if (params.progress) {
                    params.progress({ items, pages, stats, params, cmd });
                }
                if (items.length) {
                    if (cmd.Limit) {
                        cmd.Limit -= result.Count;
                        if (cmd.Limit <= 0) {
                            break;
                        }
                    }
                }
            } while (result.LastEvaluatedKey && (maxPages == null || ++pages < maxPages));
            let prev;
            if ((op == 'find' || op == 'scan') && items.length) {
                let { hash, sort } = index;
                prev = { [hash]: items[0][hash], [sort]: items[0][sort] };
                if (params.index && params.index != 'primary') {
                    let primary = this.indexes.primary;
                    prev[primary.hash] = items[0][primary.hash];
                    prev[primary.sort] = items[0][primary.sort];
                }
                if (prev[hash] == null || prev[sort] == null) {
                    prev = null;
                }
            }
            /*
                Process the response
            */
            if (params.parse) {
                items = this.parseResponse(op, expression, items);
            }
            /*
                Handle pagination next/prev
            */
            if (op == 'find' || op == 'scan') {
                if (result.LastEvaluatedKey) {
                    items.next = this.table.unmarshall(result.LastEvaluatedKey, params);
                    Object.defineProperty(items, 'next', { enumerable: false });
                }
                if (params.count || params.select == 'COUNT') {
                    items.count = result.Count;
                    Object.defineProperty(items, 'count', { enumerable: false });
                }
                if (prev) {
                    items.prev = this.table.unmarshall(prev, params);
                    Object.defineProperty(items, 'prev', { enumerable: false });
                }
                if (params.prev && op != 'scan') {
                    //  DynamoDB scan ignores ScanIndexForward
                    items = items.reverse();
                    let tmp = items.prev;
                    items.prev = items.next;
                    items.next = tmp;
                }
            }
            /*
                Log unless the user provides params.log: false.
                The logger will typically filter data/trace.
            */
            if (params.log !== false) {
                this.table.log[params.log ? 'info' : 'data'](`OneTable result for "${op}" "${this.name}"`, {
                    cmd, items, op, properties, params,
                });
            }
            /*
                Handle transparent follow. Get/Update/Find the actual item using the keys
                returned from the request on the GSI.
            */
            if (params.follow || (index.follow && params.follow !== false)) {
                if (op == 'get') {
                    return yield this.get(items[0]);
                }
                if (op == 'update') {
                    properties = Object.assign({}, properties, items[0]);
                    return yield this.update(properties);
                }
                if (op == 'find') {
                    let results = [], promises = [];
                    params = Object.assign({}, params);
                    delete params.follow;
                    delete params.index;
                    delete params.fallback;
                    for (let item of items) {
                        promises.push(this.get(item, params));
                        if (promises.length > FollowThreads) {
                            results = results.concat(yield Promise.all(promises));
                            promises = [];
                        }
                    }
                    if (promises.length) {
                        results = results.concat(yield Promise.all(promises));
                    }
                    results.next = items.next;
                    results.prev = items.prev;
                    Object.defineProperty(results, 'next', { enumerable: false });
                    Object.defineProperty(results, 'prev', { enumerable: false });
                    return results;
                }
            }
            return (op == 'find' || op == 'scan') ? items : items[0];
        });
    }
    /*
        Parse the response into Javascript objects and transform for the high level API.
     */
    parseResponse(op, expression, items) {
        let { properties, params } = expression;
        let { schema, table } = this;
        if (op == 'put') {
            //  Put requests do not return the item. So use the properties.
            items = [properties];
        }
        else {
            items = table.unmarshall(items, params);
        }
        for (let [index, item] of Object.entries(items)) {
            if (params.high && params.index == this.indexes.primary && item[this.typeField] != this.name) {
                //  High level API on the primary index and item for a different model
                continue;
            }
            let type = item[this.typeField] ? item[this.typeField] : this.name;
            let model = schema.models[type] ? schema.models[type] : this;
            if (model) {
                if (model == schema.uniqueModel) {
                    //  Special "unique" model for unique fields. Don't return in result.
                    continue;
                }
                items[index] = model.transformReadItem(op, item, properties, params);
            }
        }
        return items;
    }
    /*
        Create/Put a new item. Will overwrite existing items if exists: null.
    */
    create(properties, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params, { parse: true, high: true, exists: false }));
            let result;
            if (this.hasUniqueFields) {
                result = yield this.createUnique(properties, params);
            }
            else {
                result = yield this.putItem(properties, params);
            }
            return result;
        });
    }
    /*
        Create an item with unique attributes. Use a transaction to create a unique item for each unique attribute.
     */
    createUnique(properties, params) {
        return __awaiter(this, void 0, void 0, function* () {
            if (params.batch) {
                throw new Error_js_1.OneTableArgError('Cannot use batch with unique properties which require transactions');
            }
            let transactHere = params.transaction ? false : true;
            let transaction = params.transaction = params.transaction || {};
            let { hash, sort } = this.indexes.primary;
            let fields = this.block.fields;
            fields = Object.values(fields).filter(f => f.unique && f.attribute != hash && f.attribute != sort);
            if (this.timestamps === true || this.timestamps == 'create') {
                properties[this.createdField] = new Date();
            }
            if (this.timestamps === true || this.timestamps == 'update') {
                properties[this.updatedField] = new Date();
            }
            params.prepared = properties = this.prepareProperties('put', properties, params);
            for (let field of fields) {
                if (properties[field.name] !== undefined) {
                    let scope = '';
                    if (field.scope) {
                        scope = this.runTemplate(null, null, field, properties, params, field.scope) + '#';
                    }
                    let pk = `_unique#${scope}${this.name}#${field.attribute}#${properties[field.name]}`;
                    let sk = '_unique#';
                    yield this.schema.uniqueModel.create({ [this.hash]: pk, [this.sort]: sk }, { transaction, exists: false, return: 'NONE' });
                }
            }
            let item = yield this.putItem(properties, params);
            if (!transactHere) {
                return item;
            }
            let expression = params.expression;
            try {
                yield this.table.transact('write', params.transaction, params);
            }
            catch (err) {
                if (err instanceof Error_js_1.OneTableError && err.code === 'TransactionCanceledException' && err.context.err.message.indexOf('ConditionalCheckFailed') !== -1) {
                    let names = fields.map(f => f.name).join(', ');
                    throw new Error_js_1.OneTableError(`Cannot create unique attributes "${names}" for "${this.name}". An item of the same name already exists.`, { properties, transaction, code: 'UniqueError' });
                }
                throw err;
            }
            let items = this.parseResponse('put', expression);
            return items[0];
        });
    }
    find(properties = {}, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params, { parse: true, high: true }));
            return yield this.queryItems(properties, params);
        });
    }
    get(properties = {}, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params, { parse: true, high: true }));
            properties = this.prepareProperties('get', properties, params);
            if (params.fallback) {
                //  Fallback via find when using non-primary indexes
                params.limit = 2;
                let items = yield this.find(properties, params);
                if (items.length > 1) {
                    throw new Error_js_1.OneTableError('Get without sort key returns more than one result', { properties, code: 'NonUniqueError' });
                }
                return items[0];
            }
            //  FUTURE refactor to use getItem
            let expression = new Expression_js_1.Expression(this, 'get', properties, params);
            return yield this.run('get', expression);
        });
    }
    load(properties = {}, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params));
            properties = this.prepareProperties('get', properties, params);
            let expression = new Expression_js_1.Expression(this, 'get', properties, params);
            return yield this.table.batchLoad(expression);
        });
    }
    init(properties = {}, params = {}) {
        ({ properties, params } = this.checkArgs(properties, params, { parse: true, high: true }));
        return this.initItem(properties, params);
    }
    remove(properties, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params, { parse: true, exists: null, high: true }));
            properties = this.prepareProperties('delete', properties, params);
            if (params.fallback) {
                return yield this.removeByFind(properties, params);
            }
            let expression = new Expression_js_1.Expression(this, 'delete', properties, params);
            if (this.hasUniqueFields) {
                return yield this.removeUnique(properties, params);
            }
            else {
                return yield this.run('delete', expression);
            }
        });
    }
    /*
        Remove multiple objects after doing a full find/query
     */
    removeByFind(properties, params) {
        return __awaiter(this, void 0, void 0, function* () {
            if (params.retry) {
                throw new Error_js_1.OneTableArgError('Remove cannot retry', { properties });
            }
            params.parse = true;
            let findParams = Object.assign({}, params);
            delete findParams.transaction;
            let items = yield this.find(properties, findParams);
            if (items.length > 1 && !params.many) {
                throw new Error_js_1.OneTableError(`Removing multiple items from "${this.name}". Use many:true to enable.`, {
                    properties,
                    code: 'NonUniqueError',
                });
            }
            let response = [];
            for (let item of items) {
                let removed;
                if (this.hasUniqueFields) {
                    removed = yield this.removeUnique(item, { retry: true, transaction: params.transaction });
                }
                else {
                    removed = yield this.remove(item, { retry: true, return: params.return, transaction: params.transaction });
                }
                response.push(removed);
            }
            return response;
        });
    }
    /*
        Remove an item with unique properties. Use transactions to remove unique items.
    */
    removeUnique(properties, params) {
        return __awaiter(this, void 0, void 0, function* () {
            let transactHere = params.transaction ? false : true;
            let transaction = params.transaction = params.transaction || {};
            let { hash, sort } = this.indexes.primary;
            let fields = Object.values(this.block.fields).filter(f => f.unique && f.attribute != hash && f.attribute != sort);
            params.prepared = properties = this.prepareProperties('delete', properties, params);
            let keys = {
                [hash]: properties[hash]
            };
            if (sort) {
                keys[sort] = properties[sort];
            }
            /*
                Get the prior item so we know the previous unique property values so they can be removed.
                This must be run here, even if part of a transaction.
            */
            let prior = yield this.get(keys, { hidden: true });
            if (prior) {
                prior = this.prepareProperties('update', prior);
            }
            else if (params.exists === undefined || params.exists == true) {
                throw new Error_js_1.OneTableError('Cannot find existing item to remove', { properties, code: 'NotFoundError' });
            }
            for (let field of fields) {
                let sk = `_unique#`;
                let scope = '';
                if (field.scope) {
                    scope = this.runTemplate(null, null, field, properties, params, field.scope) + '#';
                }
                // If we had a prior record, remove unique values that existed
                if (prior && prior[field.name]) {
                    let pk = `_unique#${scope}${this.name}#${field.attribute}#${prior[field.name]}`;
                    yield this.schema.uniqueModel.remove({ [this.hash]: pk, [this.sort]: sk }, { transaction, exists: params.exists });
                }
                else if (!prior && properties[field.name] !== undefined) {
                    // if we did not have a prior record and the field is defined, try to remove it
                    let pk = `_unique#${scope}${this.name}#${field.attribute}#${properties[field.name]}`;
                    yield this.schema.uniqueModel.remove({ [this.hash]: pk, [this.sort]: sk }, {
                        transaction,
                        exists: params.exists
                    });
                }
            }
            let removed = yield this.deleteItem(properties, params);
            // Only execute transaction if we are not in a transaction
            if (transactHere) {
                removed = yield this.table.transact('write', transaction, params);
            }
            return removed;
        });
    }
    scan(properties = {}, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params, { parse: true, high: true }));
            return yield this.scanItems(properties, params);
        });
    }
    update(properties, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params, { exists: true, parse: true, high: true }));
            if (this.hasUniqueFields) {
                let hasUniqueProperties = Object.entries(properties).find((pair) => {
                    return this.block.fields[pair[0]] && this.block.fields[pair[0]].unique;
                });
                if (hasUniqueProperties) {
                    return yield this.updateUnique(properties, params);
                }
            }
            return yield this.updateItem(properties, params);
        });
    }
    upsert(properties, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            params.exists = null;
            return yield this.update(properties, params);
        });
    }
    /*
        Update an item with unique attributes and actually updating a unique property.
        Use a transaction to update a unique item for each unique attribute.
     */
    updateUnique(properties, params) {
        return __awaiter(this, void 0, void 0, function* () {
            if (params.batch) {
                throw new Error_js_1.OneTableArgError('Cannot use batch with unique properties which require transactions');
            }
            let transactHere = params.transaction ? false : true;
            let transaction = params.transaction = params.transaction || {};
            let index = this.indexes.primary;
            let { hash, sort } = index;
            params.prepared = properties = this.prepareProperties('update', properties, params);
            let keys = {
                [index.hash]: properties[index.hash]
            };
            if (index.sort) {
                keys[index.sort] = properties[index.sort];
            }
            /*
                Get the prior item so we know the previous unique property values so they can be removed.
                This must be run here, even if part of a transaction.
            */
            let prior = yield this.get(keys, { hidden: true });
            if (prior) {
                prior = this.prepareProperties('update', prior);
            }
            else if (params.exists === undefined || params.exists == true) {
                throw new Error_js_1.OneTableError('Cannot find existing item to update', { properties, code: 'NotFoundError' });
            }
            /*
                Create all required unique properties. Remove prior unique properties if they have changed.
            */
            let fields = Object.values(this.block.fields).filter(f => f.unique && f.attribute != hash && f.attribute != sort);
            for (let field of fields) {
                let toBeRemoved = (params.remove && params.remove.includes(field.name));
                let isUnchanged = (prior && properties[field.name] === prior[field.name]);
                if (isUnchanged) {
                    continue;
                }
                let scope = '';
                if (field.scope) {
                    scope = this.runTemplate(null, null, field, properties, params, field.scope) + '#';
                }
                let pk = `_unique#${scope}${this.name}#${field.attribute}#${properties[field.name]}`;
                let sk = `_unique#`;
                // If we had a prior value AND value is changing or being removed, remove old value
                if (prior && prior[field.name] && (properties[field.name] !== undefined || toBeRemoved)) {
                    /*
                        Remove prior unique properties if they have changed and create new unique property.
                    */
                    let priorPk = `_unique#${scope}${this.name}#${field.attribute}#${prior[field.name]}`;
                    if (pk == priorPk) {
                        //  Hasn't changed
                        continue;
                    }
                    yield this.schema.uniqueModel.remove({ [this.hash]: priorPk, [this.sort]: sk }, {
                        transaction,
                        exists: null,
                        execute: params.execute,
                        log: params.log,
                    });
                }
                // If value is changing, add new unique value
                if (properties[field.name] !== undefined) {
                    yield this.schema.uniqueModel.create({ [this.hash]: pk, [this.sort]: sk }, {
                        transaction,
                        exists: false,
                        return: 'NONE',
                        log: params.log,
                        execute: params.execute
                    });
                }
            }
            let item = yield this.updateItem(properties, params);
            if (!transactHere) {
                return item;
            }
            /*
                Perform all operations in a transaction so update will only be applied if the unique properties can be created.
            */
            try {
                yield this.table.transact('write', params.transaction, params);
            }
            catch (err) {
                if (err instanceof Error_js_1.OneTableError && err.code === 'TransactionCanceledException' && err.context.err.message.indexOf('ConditionalCheckFailed') !== -1) {
                    let names = fields.map(f => f.name).join(', ');
                    throw new Error_js_1.OneTableError(`Cannot update unique attributes "${names}" for "${this.name}". An item of the same name already exists.`, { properties, transaction, code: 'UniqueError' });
                }
                throw err;
            }
            if (params.return == 'none' || params.return === false) {
                return;
            }
            if (params.return == 'get') {
                return yield this.get(keys, {
                    hidden: params.hidden,
                    log: params.log,
                    parse: params.parse,
                    execute: params.execute,
                });
            }
            if (params.return) {
                throw new Error_js_1.OneTableArgError('Update cannot return an updated item that contain unique attributes');
            }
            else {
                if (this.table.warn !== false) {
                    console.warn(`Update with unique items uses transactions and cannot return the updated item.` +
                        `Use params {return: 'none'} to squelch this warning. ` +
                        `Use {return: 'get'} to do a non-transactional get of the item after the update. ` +
                        `In future releases, this will throw an exception.`);
                }
                return properties;
            }
        });
    }
    //  Low level API
    /* private */
    deleteItem(properties, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params));
            if (!params.prepared) {
                properties = this.prepareProperties('delete', properties, params);
            }
            let expression = new Expression_js_1.Expression(this, 'delete', properties, params);
            return yield this.run('delete', expression);
        });
    }
    /* private */
    getItem(properties, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params));
            properties = this.prepareProperties('get', properties, params);
            let expression = new Expression_js_1.Expression(this, 'get', properties, params);
            return yield this.run('get', expression);
        });
    }
    /* private */
    initItem(properties, params = {}) {
        ({ properties, params } = this.checkArgs(properties, params));
        let fields = this.block.fields;
        this.setDefaults('init', fields, properties, params);
        //  Ensure all fields are present
        for (let key of Object.keys(fields)) {
            if (properties[key] === undefined) {
                properties[key] = null;
            }
        }
        this.runTemplates('put', this.indexes.primary, this.block.deps, properties, params);
        return properties;
    }
    /* private */
    putItem(properties, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params));
            if (!params.prepared) {
                if (this.timestamps === true || this.timestamps == 'create') {
                    properties[this.createdField] = new Date();
                }
                if (this.timestamps === true || this.timestamps == 'update') {
                    properties[this.updatedField] = new Date();
                }
                properties = this.prepareProperties('put', properties, params);
            }
            let expression = new Expression_js_1.Expression(this, 'put', properties, params);
            return yield this.run('put', expression);
        });
    }
    /* private */
    queryItems(properties = {}, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params));
            properties = this.prepareProperties('find', properties, params);
            let expression = new Expression_js_1.Expression(this, 'find', properties, params);
            return yield this.run('find', expression);
        });
    }
    //  Note: scanItems will return all model types
    /* private */
    scanItems(properties = {}, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params));
            properties = this.prepareProperties('scan', properties, params);
            let expression = new Expression_js_1.Expression(this, 'scan', properties, params);
            return yield this.run('scan', expression);
        });
    }
    /* private */
    updateItem(properties, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params));
            if (this.timestamps === true || this.timestamps == 'update') {
                let now = new Date();
                properties[this.updatedField] = now;
                if (params.exists == null) {
                    let field = this.block.fields[this.createdField] || this.table;
                    let when = (field.isoDates) ? now.toISOString() : now.getTime();
                    params.set = params.set || {};
                    params.set[this.createdField] = `if_not_exists(\${${this.createdField}}, {${when}})`;
                }
            }
            properties = this.prepareProperties('update', properties, params);
            let expression = new Expression_js_1.Expression(this, 'update', properties, params);
            return yield this.run('update', expression);
        });
    }
    /* private */
    fetch(models, properties = {}, params = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            ({ properties, params } = this.checkArgs(properties, params));
            if (models.length == 0) {
                return {};
            }
            let where = [];
            for (let model of models) {
                where.push(`\${${this.typeField}} = {${model}}`);
            }
            if (params.where) {
                params.where = `(${params.where}) and (${where.join(' or ')})`;
            }
            else {
                params.where = where.join(' or ');
            }
            params.parse = true;
            params.hidden = true;
            let items = yield this.queryItems(properties, params);
            return this.table.groupByType(items);
        });
    }
    /*
        Map Dynamo types to Javascript types after reading data
     */
    transformReadItem(op, raw, properties, params) {
        if (!raw) {
            return raw;
        }
        return this.transformReadBlock(op, raw, properties, params, this.block.fields);
    }
    transformReadBlock(op, raw, properties, params, fields) {
        let rec = {};
        for (let [name, field] of Object.entries(fields)) {
            //  Skip hidden params. Follow needs hidden params to do the follow.
            if (field.hidden && params.hidden !== true && params.follow !== true) {
                continue;
            }
            let att, sub;
            if (op == 'put') {
                att = field.name;
            }
            else {
                [att, sub] = field.attribute;
            }
            let value = raw[att];
            if (value === undefined) {
                continue;
            }
            if (sub) {
                value = value[sub];
            }
            if (field.crypt && params.decrypt !== false) {
                value = this.decrypt(value);
            }
            if (field.default !== undefined && value === undefined) {
                if (typeof field.default == 'function') {
                    // console.warn('WARNING: default functions are DEPRECATED and will be removed soon.')
                    value = field.default(this, field.name, properties);
                }
                else {
                    value = field.default;
                }
            }
            else if (value === undefined) {
                if (field.required) {
                    this.table.log.error(`Required field "${name}" in model "${this.name}" not defined in table item`, {
                        model: this.name, raw, params, field
                    });
                }
                continue;
            }
            else if (field.schema && typeof value == 'object') {
                rec[name] = this.transformReadBlock(op, raw[name], properties[name] || {}, params, field.block.fields);
            }
            else {
                rec[name] = this.transformReadAttribute(field, name, value, params, properties);
            }
        }
        if (this.generic) {
            //  Generic must include attributes outside the schema.
            for (let [name, value] of Object.entries(raw)) {
                if (rec[name] === undefined) {
                    rec[name] = value;
                }
            }
        }
        if (params.hidden == true && rec[this.typeField] === undefined && !this.generic) {
            rec[this.typeField] = this.name;
        }
        if (this.table.params.transform) {
            let opForTransform = TransformParseResponseAs[op];
            rec = this.table.params.transform(this, ReadWrite[opForTransform], rec, properties, params, raw);
        }
        return rec;
    }
    transformReadAttribute(field, name, value, params, properties) {
        if (typeof params.transform == 'function') {
            //  Invoke custom data transform after reading
            return params.transform(this, 'read', name, value, properties);
        }
        if (field.type == 'date') {
            return value ? new Date(value) : null;
        }
        if (field.type == 'buffer' || field.type == 'arraybuffer' || field.type == 'binary') {
            return Buffer.from(value, 'base64');
        }
        return value;
    }
    /*
        Validate properties and map types if required.
        Note: this does not map names to attributes or evaluate value templates, that happens in Expression.
     */
    prepareProperties(op, properties, params = {}) {
        delete params.fallback;
        let index = this.selectIndex(op, params);
        if (this.needsFallback(op, index, params)) {
            params.fallback = true;
            return properties;
        }
        let rec = this.collectProperties(op, this.block, index, properties, params);
        if (params.fallback) {
            return properties;
        }
        if (op != 'scan' && this.getHash(rec, this.block.fields, index, params) == null) {
            this.table.log.error(`Empty hash key`, { properties, params, op, rec, index, model: this.name });
            throw new Error_js_1.OneTableError(`Empty hash key. Check hash key and any value template variable references.`, {
                properties, rec, code: 'MissingError',
            });
        }
        if (this.table.params.transform && ReadWrite[op] == 'write') {
            rec = this.table.params.transform(this, ReadWrite[op], rec, properties, params);
        }
        return rec;
    }
    //  Handle fallback for get/delete as GSIs only support find and scan
    needsFallback(op, index, params) {
        if (index != this.indexes.primary && op != 'find' && op != 'scan') {
            if (params.low) {
                throw new Error_js_1.OneTableArgError('Cannot use non-primary index for "${op}" operation');
            }
            return true;
        }
        return false;
    }
    /*
        Return the hash property name for the selected index.
    */
    getHash(rec, fields, index, params) {
        let generic = params.generic != null ? params.generic : this.generic;
        if (generic) {
            return rec[index.hash];
        }
        let field = Object.values(fields).find(f => f.attribute[0] == index.hash);
        if (!field) {
            return null;
        }
        return rec[field.name];
    }
    /*
        Get the index for the request
    */
    selectIndex(op, params) {
        let index;
        if (params.index && params.index != 'primary') {
            index = this.indexes[params.index];
            if (!index) {
                throw new Error_js_1.OneTableError(`Cannot find index ${params.index}`, { code: 'MissingError' });
            }
        }
        else {
            index = this.indexes.primary;
        }
        return index;
    }
    /*
        Collect the required attribute from the properties and context.
        This handles tunneled properties, blends context properties, resolves default values, handles Nulls and empty strings,
        and invokes validations. Nested schemas are handled here.
    */
    collectProperties(op, block, index, properties, params, context, rec = {}) {
        let fields = block.fields;
        if (!context) {
            context = params.context || this.table.context;
        }
        if (this.nested && !KeysOnly[op]) {
            //  Process nested schema recursively
            for (let field of Object.values(fields)) {
                if (field.schema) {
                    let name = field.name;
                    let value = properties[name];
                    if (op == 'put') {
                        value = value || field.default;
                        if (value === undefined && field.required) {
                            value = {};
                        }
                    }
                    if (value !== undefined) {
                        rec[name] = rec[name] || value;
                        this.collectProperties(op, field.block, index, value, params, context[name] || {}, rec[name]);
                    }
                }
            }
        }
        this.tunnelProperties(properties, params);
        this.addContext(op, fields, index, properties, params, context);
        this.setDefaults(op, fields, properties, params);
        this.runTemplates(op, index, block.deps, properties, params);
        this.convertNulls(op, fields, properties, params);
        this.validateProperties(op, fields, properties, params);
        this.selectProperties(op, block, index, properties, params, rec);
        this.transformProperties(op, fields, properties, params, rec);
        return rec;
    }
    /*
        For typescript, we cant use properties: {name: [between], name: {begins}}
        so tunnel from the params. Works for between, begins, < <= = >= >
    */
    tunnelProperties(properties, params) {
        if (params.tunnel) {
            for (let [kind, settings] of Object.entries(params.tunnel)) {
                for (let [key, value] of Object.entries(settings)) {
                    properties[key] = { [kind]: value };
                }
            }
        }
    }
    /*
        Select the attributes to include in the request
    */
    selectProperties(op, block, index, properties, params, rec) {
        let project = this.getProjection(index);
        /*
            NOTE: Value templates for unique items may need other properties when removing unique items
        */
        for (let [name, field] of Object.entries(block.fields)) {
            if (field.schema) {
                if (properties[name]) {
                    rec[name] = Array.isArray(field.type) ? [] : {};
                    this.selectProperties(op, field.block, index, properties[name], params, rec[name]);
                }
                continue;
            }
            let omit = false;
            if (block == this.block) {
                let attribute = field.attribute[0];
                //  Missing sort key on a high-level API for get/delete
                if (properties[name] == null && attribute == index.sort && params.high && KeysOnly[op]) {
                    if (op == 'delete' && !params.many) {
                        throw new Error_js_1.OneTableError('Missing sort key', { code: 'MissingError', properties, params });
                    }
                    /*
                        Missing sort key for high level get, or delete without "any".
                        Fallback to find to select the items of interest. Get will throw if more than one result is returned.
                    */
                    params.fallback = true;
                    return;
                }
                if (KeysOnly[op] && attribute != index.hash && attribute != index.sort && !this.hasUniqueFields) {
                    //  Keys only for get and delete. Must include unique properties and all properties if unique value templates.
                    //  FUTURE: could have a "strict" mode where we warn for other properties instead of ignoring.
                    omit = true;
                }
                else if (project && project.indexOf(attribute) < 0) {
                    //  Attribute is not projected
                    omit = true;
                }
                else if (name == this.typeField && name != index.hash && name != index.sort && op == 'find') {
                    omit = true;
                }
            }
            if (!omit && properties[name] !== undefined) {
                rec[name] = properties[name];
            }
        }
        this.addProjectedProperties(op, properties, params, project, rec);
    }
    getProjection(index) {
        let project = index.project;
        if (project) {
            if (project == 'all') {
                project = null;
            }
            else if (project == 'keys') {
                let primary = this.indexes.primary;
                project = [primary.hash, primary.sort, index.hash, index.sort];
            }
        }
        return project;
    }
    //  For generic (table low level APIs), add all properties that are projected
    addProjectedProperties(op, properties, params, project, rec) {
        let generic = params.generic != null ? params.generic : this.generic;
        if (generic && !KeysOnly[op]) {
            for (let [name, value] of Object.entries(properties)) {
                if (project && project.indexOf(name) < 0) {
                    continue;
                }
                if (rec[name] === undefined) {
                    //  Cannot do all type transformations - don't have enough info without fields
                    if (value instanceof Date) {
                        if (this.isoDates) {
                            rec[name] = value.toISOString();
                        }
                        else {
                            rec[name] = value.getTime();
                        }
                    }
                    else {
                        rec[name] = value;
                    }
                }
            }
        }
        return rec;
    }
    /*
        Add context to properties. If 'put', then for all fields, otherwise just key fields.
        Context overrides properties.
     */
    addContext(op, fields, index, properties, params, context) {
        for (let field of Object.values(fields)) {
            if (op == 'put' || (field.attribute[0] != index.hash && field.attribute[0] != index.sort)) {
                if (context[field.name] !== undefined) {
                    properties[field.name] = context[field.name];
                }
            }
        }
        if (!this.generic && fields == this.block.fields) {
            //  Set type field for the top level only
            properties[this.typeField] = this.name;
        }
    }
    /*
        Set default property values on Put.
    */
    setDefaults(op, fields, properties, params) {
        if (op != 'put' && op != 'init' && !(op == 'update' && params.exists == null)) {
            return;
        }
        for (let field of Object.values(fields)) {
            if (field.type == 'object' && field.schema) {
                properties[field.name] = properties[field.name] || {};
                this.setDefaults(op, field.block.fields, properties[field.name], params);
            }
            else {
                let value = properties[field.name];
                //  Set defaults and uuid fields
                if (value === undefined && !field.value) {
                    if (field.default !== undefined) {
                        value = field.default;
                    }
                    else if (op == 'init') {
                        if (!field.generate) {
                            //  Set non-default, non-uuid properties to null
                            value = null;
                        }
                    }
                    else if (field.generate) {
                        if (field.generate === true) {
                            value = this.table.generate();
                        }
                        else if (field.generate == 'uuid') {
                            value = this.table.uuid();
                        }
                        else if (field.generate == 'ulid') {
                            value = this.table.ulid();
                        }
                    }
                    if (value !== undefined) {
                        properties[field.name] = value;
                    }
                }
            }
        }
        return properties;
    }
    /*
        Remove null properties from the table unless Table.nulls == true
    */
    convertNulls(op, fields, properties, params) {
        for (let [name, value] of Object.entries(properties)) {
            let field = fields[name];
            if (!field)
                continue;
            if (value === null && field.nulls !== true) {
                if (field.required && (
                //  create with null/undefined, or update with null property
                (op == 'put' && properties[field.name] == null) ||
                    (op == 'update' && properties[field.name] === null))) {
                    //  Validation will catch this
                    continue;
                }
                if (params.remove && !Array.isArray(params.remove)) {
                    params.remove = [params.remove];
                }
                else {
                    params.remove = params.remove || [];
                }
                params.remove.push(field.pathname);
                delete properties[name];
            }
            else if (typeof value == 'object' && (field.type == 'object' || field.type == 'array')) {
                properties[name] = this.removeNulls(field, value);
            }
        }
    }
    /*
        Process value templates and property values that are functions
     */
    runTemplates(op, index, deps, properties, params) {
        for (let field of deps) {
            let name = field.name;
            if (field.isIndexed && (op != 'put' && op != 'update') &&
                field.attribute[0] != index.hash && field.attribute[0] != index.sort) {
                //  Ignore indexes not being used for this call
                continue;
            }
            if (field.value === true && typeof this.table.params.value == 'function') {
                properties[name] = this.table.params.value(this, field.pathname, properties, params);
            }
            else if (typeof properties[name] == 'function') {
                //  Undocumented and not supported for typescript
                properties[name] = properties[name](field.pathname, properties);
            }
            else if (properties[name] === undefined) {
                if (field.value) {
                    if (typeof field.value == 'function') {
                        // console.warn('WARNING: value functions are DEPRECATED and will be removed soon.')
                        properties[name] = field.value(field.pathname, properties);
                    }
                    else {
                        let value = this.runTemplate(op, index, field, properties, params, field.value);
                        if (value != null) {
                            properties[name] = value;
                        }
                    }
                }
            }
        }
    }
    /*
        Expand a value template by substituting ${variable} values from context and properties.
     */
    runTemplate(op, index, field, properties, params, value) {
        /*
            Replace property references in ${var}
            Support ${var:length:pad-character} which is useful for sorting.
        */
        value = value.replace(/\${(.*?)}/g, (match, varName) => {
            let [name, len, pad] = varName.split(':');
            let v = this.getPropValue(properties, name);
            if (v != null) {
                if (v instanceof Date) {
                    v = this.transformWriteDate(field, v);
                }
                if (len) {
                    //  Add leading padding for sorting numerics
                    pad = pad || '0';
                    let s = v + '';
                    while (s.length < len)
                        s = pad + s;
                    v = s;
                }
            }
            else {
                v = match;
            }
            if (typeof v == 'object' && v.toString() == '[object Object]') {
                throw new Error_js_1.OneTableError(`Value for "${field.pathname}" is not a primitive value`, { code: 'TypeError' });
            }
            return v;
        });
        /*
            Consider unresolved template variables. If field is the sort key and doing find,
            then use sort key prefix and begins_with, (provide no where clause).
         */
        if (value.indexOf('${') >= 0 && index) {
            if (field.attribute[0] == index.sort) {
                if (op == 'find') {
                    //  Strip from first ${ onward and retain fixed prefix portion
                    value = value.replace(/\${.*/g, '');
                    if (value) {
                        return { begins: value };
                    }
                }
            }
            /*
                Return undefined if any variables remain undefined. This is critical to stop updating
                templates which do not have all the required properties to complete.
            */
            return undefined;
        }
        return value;
    }
    //  Public routine to run templates
    template(name, properties, params = {}) {
        let fields = this.block.fields;
        let field = fields[name];
        if (!field) {
            throw new Error_js_1.OneTableError('Cannot find field', { name });
        }
        return this.runTemplate('find', null, field, properties, params, field.value);
    }
    validateProperties(op, fields, properties, params) {
        if (op != 'put' && op != 'update') {
            return;
        }
        let validation = {};
        if (typeof this.table.params.validate == 'function') {
            validation = this.table.params.validate(this, properties, params) || {};
        }
        for (let [name, value] of Object.entries(properties)) {
            let field = fields[name];
            if (!field)
                continue;
            if (params.validate || field.validate || field.enum) {
                value = this.validateProperty(field, value, validation, params);
                properties[name] = value;
            }
        }
        for (let field of Object.values(fields)) {
            //  If required and create, must be defined. If required and update, must not be null.
            if (field.required && ((op == 'put' && properties[field.name] == null) || (op == 'update' && properties[field.name] === null))) {
                validation[field.name] = `Value not defined for required field "${field.name}"`;
            }
        }
        if (Object.keys(validation).length > 0) {
            let error = new Error_js_1.OneTableError(`Validation Error in "${this.name}" for "${Object.keys(validation).join(', ')}"`, { validation, code: 'ValidationError' });
            throw error;
        }
    }
    validateProperty(field, value, details, params) {
        let fieldName = field.name;
        //  DEPRECATE
        if (typeof params.validate == 'function') {
            // console.warn('WARNING: params.validate functions are DEPRECATED and will be removed soon.')
            let error;
            ({ error, value } = params.validate(this, field, value));
            if (error) {
                details[fieldName] = error;
            }
        }
        let validate = field.validate;
        if (validate) {
            if (value === null) {
                if (field.required && field.value == null) {
                    details[fieldName] = `Value not defined for "${fieldName}"`;
                }
            }
            else if (validate instanceof RegExp) {
                if (!validate.exec(value)) {
                    details[fieldName] = `Bad value "${value}" for "${fieldName}"`;
                }
            }
            else {
                let pattern = validate.toString();
                if (pattern[0] == '/' && pattern.lastIndexOf('/') > 0) {
                    let parts = pattern.split('/');
                    let qualifiers = parts.pop();
                    let pat = parts.slice(1).join('/');
                    validate = new RegExp(pat, qualifiers);
                    if (!validate.exec(value)) {
                        details[fieldName] = `Bad value "${value}" for "${fieldName}"`;
                    }
                }
                else {
                    if (!value.match(pattern)) {
                        details[fieldName] = `Bad value "${value}" for "${fieldName}"`;
                    }
                }
            }
        }
        if (field.enum) {
            if (field.enum.indexOf(value) < 0) {
                details[fieldName] = `Bad value "${value}" for "${fieldName}"`;
            }
        }
        return value;
    }
    transformProperties(op, fields, properties, params, rec) {
        for (let [name, field] of Object.entries(fields)) {
            let value = rec[name];
            if (value !== undefined && !field.schema) {
                rec[name] = this.transformWriteAttribute(op, field, value, properties, params);
            }
        }
        return rec;
    }
    /*
        Transform an attribute before writing. This invokes transform callbacks and handles nested objects.
     */
    transformWriteAttribute(op, field, value, properties, params) {
        let type = field.type;
        if (typeof params.transform == 'function') {
            value = params.transform(this, 'write', field.name, value, properties, null);
        }
        else if (value == null && field.nulls === true) {
            //  Keep the null
        }
        else if (op == 'find' && value != null && typeof value == 'object') {
            //  Find used {begins} and other operators
            value = this.transformNestedWriteFields(field, value);
        }
        else if (type == 'date') {
            value = this.transformWriteDate(field, value);
        }
        else if (type == 'number') {
            let num = Number(value);
            if (isNaN(num)) {
                throw new Error_js_1.OneTableError(`Invalid value "${value}" provided for field "${field.name}"`, { code: 'ValidationError' });
            }
            value = num;
        }
        else if (type == 'boolean') {
            if (value == 'false' || value == 'null' || value == 'undefined') {
                value = false;
            }
            value = Boolean(value);
        }
        else if (type == 'string') {
            if (value != null) {
                value = value.toString();
            }
        }
        else if (type == 'buffer' || type == 'arraybuffer' || type == 'binary') {
            if (value instanceof Buffer || value instanceof ArrayBuffer || value instanceof DataView) {
                value = value.toString('base64');
            }
        }
        else if (type == 'array') {
            //  Heursistics to accept legacy string values for array types. Note: TS would catch this also.
            if (value != null && !Array.isArray(value)) {
                if (value == '') {
                    value = [];
                }
                else {
                    //  FUTURE: should be moved to validations
                    throw new Error_js_1.OneTableArgError(`Invalid data type for Array field "${field.name}" in "${this.name}"`);
                    // value = [value]
                }
            }
        }
        else if (type == 'set' && Array.isArray(value)) {
            value = this.transformWriteSet(type, value);
        }
        else if (type == 'object' && (value != null && typeof value == 'object')) {
            value = this.transformNestedWriteFields(field, value);
        }
        if (field.crypt && value != null) {
            value = this.encrypt(value);
        }
        return value;
    }
    transformNestedWriteFields(field, obj) {
        for (let [key, value] of Object.entries(obj)) {
            let type = field.type;
            if (value instanceof Date) {
                obj[key] = this.transformWriteDate(field, value);
            }
            else if (value instanceof Buffer || value instanceof ArrayBuffer || value instanceof DataView) {
                value = value.toString('base64');
            }
            else if (Array.isArray(value) && (field.type == Set || type == Set)) {
                value = this.transformWriteSet(type, value);
            }
            else if (value == null && field.nulls !== true) {
                //  Skip nulls
                continue;
            }
            else if (value != null && typeof value == 'object') {
                obj[key] = this.transformNestedWriteFields(field, value);
            }
        }
        return obj;
    }
    transformWriteSet(type, value) {
        if (!Array.isArray(value)) {
            throw new Error_js_1.OneTableError('Set values must be arrays', { code: 'TypeError' });
        }
        if (type == Set || type == 'Set' || type == 'set') {
            let v = value.values().next().value;
            if (typeof v == 'string') {
                value = value.map(v => v.toString());
            }
            else if (typeof v == 'number') {
                value = value.map(v => Number(v));
            }
            else if (v instanceof Buffer || v instanceof ArrayBuffer || v instanceof DataView) {
                value = value.map(v => v.toString('base64'));
            }
        }
        else {
            throw new Error_js_1.OneTableError('Unknown type', { code: 'TypeError' });
        }
        return value;
    }
    /*
        Handle dates. Supports epoch and ISO date transformations.
    */
    transformWriteDate(field, value) {
        if (field.ttl) {
            //  Convert dates to DynamoDB TTL
            if (value instanceof Date) {
                value = value.getTime();
            }
            else if (typeof value == 'string') {
                value = (new Date(Date.parse(value))).getTime();
            }
            value = Math.ceil(value / 1000);
        }
        else if (field.isoDates) {
            if (value instanceof Date) {
                value = value.toISOString();
            }
            else if (typeof value == 'string') {
                value = (new Date(Date.parse(value))).toISOString();
            }
            else if (typeof value == 'number') {
                value = (new Date(value)).toISOString();
            }
        }
        else {
            //  Convert dates to unix epoch in milliseconds
            if (value instanceof Date) {
                value = value.getTime();
            }
            else if (typeof value == 'string') {
                value = (new Date(Date.parse(value))).getTime();
            }
        }
        return value;
    }
    /*
        Get a hash of all the property names of the indexes. Keys are properties, values are index names.
        Primary takes precedence if property used in multiple indexes (LSIs)
     */
    getIndexProperties(indexes) {
        let properties = {};
        for (let [indexName, index] of Object.entries(indexes)) {
            for (let [type, pname] of Object.entries(index)) {
                if (type == 'hash' || type == 'sort') {
                    if (properties[pname] != 'primary') {
                        //  Let primary take precedence
                        properties[pname] = indexName;
                    }
                }
            }
        }
        return properties;
    }
    encrypt(text, name = 'primary', inCode = 'utf8', outCode = 'base64') {
        return this.table.encrypt(text, name, inCode, outCode);
    }
    decrypt(text, inCode = 'base64', outCode = 'utf8') {
        return this.table.decrypt(text, inCode, outCode);
    }
    /*
        Clone properties and params to callers objects are not polluted
    */
    checkArgs(properties, params, overrides = {}) {
        if (params.checked) {
            //  Only need to clone once
            return { properties, params };
        }
        if (!properties) {
            throw new Error_js_1.OneTableArgError('Missing properties');
        }
        if (typeof params != 'object') {
            throw new Error_js_1.OneTableError('Invalid type for params', { code: 'TypeError' });
        }
        //  Must not use merge as we need to modify the callers batch/transaction objects
        params = Object.assign(overrides, params);
        params.checked = true;
        properties = this.table.assign({}, properties);
        return { properties, params };
    }
    /*
        Handle nulls and empty strings properly according to nulls preference.
        NOTE: DynamoDB can handle empty strings as top level non-key string attributes, but not nested in lists or maps. Ugh!
    */
    removeNulls(field, obj) {
        let result;
        /*
            Loop over plain objects and arrays only
        */
        if (obj !== null && typeof obj == 'object' && (obj.constructor.name == 'Object' || obj.constructor.name == 'Array')) {
            result = Array.isArray(obj) ? [] : {};
            for (let [key, value] of Object.entries(obj)) {
                if (value === '') {
                    //  Convert to null and handle according to field.nulls
                    value = null;
                }
                if (value == null && field.nulls !== true) {
                    //  Match null and undefined
                    continue;
                }
                else if (typeof value == 'object') {
                    result[key] = this.removeNulls(field, value);
                }
                else {
                    result[key] = value;
                }
            }
        }
        else {
            result = obj;
        }
        return result;
    }
}
exports.Model = Model;