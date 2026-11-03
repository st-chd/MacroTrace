import { convertValueType } from '../../../../utils.js';

// Same rules as scripts/variables.js, but on a plain object that is never saved.
export function createScope(store) {
    function get(name, args = {}) {
        let value = store[args.key ?? name];
        if (args.index !== undefined) {
            try {
                value = JSON.parse(value);
                const numIndex = Number(args.index);
                value = Number.isNaN(numIndex) ? value[args.index] : value[numIndex];
                if (typeof value == 'object') {
                    value = JSON.stringify(value);
                }
            } catch {
                // same as ST: keep what we have
            }
        }
        return (value?.trim?.() === '' || isNaN(Number(value))) ? (value || '') : Number(value);
    }

    function set(name, value, args = {}) {
        if (!name) {
            throw new Error('Variable name cannot be empty or undefined.');
        }
        if (args.index !== undefined) {
            try {
                let parsed = JSON.parse(store[name] ?? 'null');
                const numIndex = Number(args.index);
                if (Number.isNaN(numIndex)) {
                    if (parsed === null) parsed = {};
                    parsed[args.index] = convertValueType(value, args.as);
                } else {
                    if (parsed === null) parsed = [];
                    parsed[numIndex] = convertValueType(value, args.as);
                }
                store[name] = JSON.stringify(parsed);
            } catch {
                // same as ST: ignore
            }
        } else {
            store[name] = value;
        }
        return value;
    }

    function add(name, value) {
        const currentValue = get(name) || 0;
        try {
            const parsedValue = JSON.parse(currentValue);
            if (Array.isArray(parsedValue)) {
                parsedValue.push(value);
                set(name, JSON.stringify(parsedValue));
                return parsedValue;
            }
        } catch {
            // not an array
        }
        const increment = Number(value);
        if (isNaN(increment) || isNaN(Number(currentValue))) {
            const stringValue = String(currentValue || '') + value;
            set(name, stringValue);
            return stringValue;
        }
        const newValue = Number(currentValue) + increment;
        if (isNaN(newValue)) {
            return '';
        }
        set(name, newValue);
        return newValue;
    }

    return {
        get,
        set,
        add,
        inc: (name) => add(name, 1),
        dec: (name) => add(name, -1),
        has: (name) => store[name] !== undefined,
        del: (name) => {
            delete store[name];
            return '';
        },
    };
}
