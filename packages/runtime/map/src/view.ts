// tslint:disable:align
import { ISequencedDocumentMessage } from "@prague/container-definitions";
import { IComponentRuntime } from "@prague/runtime-definitions";
import { ISharedObject, SharedObject, ValueType } from "@prague/shared-object-common";
import { IMapOperation, IMapValue } from "./definitions";
import { SharedDirectory } from "./directory";
import { IValueChanged, IValueOpEmitter, SerializeFilter } from "./interfaces";
import { SharedMap } from "./map";

class ValueOpEmitter implements IValueOpEmitter {
    constructor(private readonly type: string, private readonly key: string, private readonly map: SharedMap) {
    }

    public emit(operation: string, previousValue: any, params: any) {
        const op: IMapOperation = {
            key: this.key,
            type: this.type,
            value: {
                type: operation,
                value: params,
            },
        };

        this.map.submitMapMessage(op);
        const event: IValueChanged = { key: this.key, previousValue };
        this.map.emit("valueChanged", event, true, null);
    }
}

export interface ILocalViewElement {
    // The type of local value
    localType: string;

    // The actual local value
    localValue: any;
}

export class MapView {
    public readonly data = new Map<string, ILocalViewElement>();

    constructor(private readonly map: SharedMap, private readonly runtime: IComponentRuntime, id: string) {
    }

    public async populate(data: { [key: string]: IMapValue }): Promise<void> {
        const localValuesP = new Array<Promise<{ key: string, value: ILocalViewElement }>>();

        // tslint:disable-next-line:forin
        for (const key in data) {
            const value = data[key];
            const localValueP = this.fill(key, value)
                .then((filledValue) => ({ key, value: filledValue }));
            localValuesP.push(localValueP);
        }

        const localValues = await Promise.all(localValuesP);
        for (const localValue of localValues) {
            this.data.set(localValue.key, localValue.value);
        }
    }

    // TODO: fix to pass-through when meta-data moved to separate map
    public forEach(callbackFn: (value: any, key: any, map: Map<string, any>) => void) {
        this.data.forEach((value, key, m) => {
            callbackFn(value.localValue, key, m);
        });
    }

    public get(key: string) {
        if (!this.data.has(key)) {
            return undefined;
        }

        // Let's stash the *type* of the object on the key
        const value = this.data.get(key);

        return value.localValue;
    }

    public getMap() {
        return this.map;
    }

    public async wait<T>(key: string): Promise<T> {
        // Return immediately if the value already exists
        if (this.has(key)) {
            /* tslint:disable:no-unsafe-any */
            /* tslint:disable:no-object-literal-type-assertion */
            return this.get(key);
        }

        // Otherwise subscribe to changes
        return new Promise<T>((resolve, reject) => {
            const callback = (value: { key: string }) => {
                if (key === value.key) {
                    resolve(this.get(value.key));
                    this.map.removeListener("valueChanged", callback);
                }
            };

            this.map.on("valueChanged", callback);
        });
    }

    public has(key: string): boolean {
    return this.data.has(key);
    }

    public attachAll() {
        for (const [, value] of this.data) {
            if (value.localValue instanceof SharedObject) {
                value.localValue.attach();
            }
        }
    }

    public prepareOperationValue<T = any>(key: string, value: T, type?: string) {
        let operationValue: IMapValue;
        if (type) {
            const valueType = this.map.getValueType(type);
            if (!valueType) {
                throw new Error(`Unknown type '${type}' specified`);
            }

            // set operationValue first with the raw value params prior to doing the load
            operationValue = {
                type,
                value,
            };
            // tslint:disable-next-line:no-parameter-reassignment
            value = valueType.factory.load(new ValueOpEmitter(type, key, this.map), value);
        } else {
            const valueType = value instanceof SharedObject
                ? ValueType[ValueType.Shared]
                : ValueType[ValueType.Plain];
            operationValue = this.spill({ localType: valueType, localValue: value });
        }
        return { operationValue, localValue : value };
    }

    public set<T = any>(key: string, value: T, type?: string): void {
        const values = this.prepareOperationValue(key, value, type);
        const op: IMapOperation = {
            key,
            type: "set",
            value: values.operationValue,
        };

        this.setCore(
            op.key,
            {
                localType: values.operationValue.type,
                localValue: values.localValue,
            },
            true,
            null);
        this.map.submitMapKeyMessage(op);
    }

    public delete(key: string) {
        const op: IMapOperation = {
            key,
            type: "delete",
        };

        const successfullyRemoved = this.deleteCore(op.key, true, null);
        this.map.submitMapKeyMessage(op);
        return successfullyRemoved;
    }

    public keys(): IterableIterator<string> {
        return this.data.keys();
    }

    public clear(): void {
        const op: IMapOperation = {
            type: "clear",
        };

        this.clearCore(true, null);
        this.map.submitMapClearMessage(op);
    }

    /**
     * Serializes the shared map to a JSON string
     */
    public serialize(filter: SerializeFilter): string {
        const serialized: any = {};
        this.data.forEach((value, key) => {
            const spilledValue = this.spill(value);
            const filteredValue = filter(key, spilledValue.value, spilledValue.type);
            serialized[key] = { type: spilledValue.type, value: filteredValue } as IMapValue;
        });
        return JSON.stringify(serialized);
    }

    public setCore(key: string, value: ILocalViewElement, local: boolean, op: ISequencedDocumentMessage) {
        const previousValue = this.get(key);
        this.data.set(key, value);
        const event: IValueChanged = { key, previousValue };
        this.map.emit("valueChanged", event, local, op);
    }

    public prepareSetCore(key: string, value: IMapValue): Promise<ILocalViewElement> {
        return this.fill(key, value);
    }

    public clearCore(local: boolean, op: ISequencedDocumentMessage) {
        this.data.clear();
        this.map.emit("clear", local, op);
    }

    public deleteCore(key: string, local: boolean, op: ISequencedDocumentMessage) {
        const previousValue = this.get(key);
        const successfullyRemoved = this.data.delete(key);
        if (successfullyRemoved) {
            const event: IValueChanged = { key, previousValue };
            this.map.emit("valueChanged", event, local, op);
        }
        return successfullyRemoved;
    }

    public clearExceptPendingKeys(pendingKeys: Map<string, number>) {
        // Assuming the pendingKeys is small and the map is large
        // we will get the value for the pendingKeys and clear the map
        const temp = new Map<string, ILocalViewElement>();
        pendingKeys.forEach((value, key, map) => {
            temp.set(key, this.data.get(key));
        });
        this.data.clear();
        temp.forEach((value, key, map) => {
            this.data.set(key, value);
        });
    }

    protected async fill(key: string, remote: IMapValue): Promise<ILocalViewElement> {
        let translatedValue: any;
        if (remote.type === ValueType[ValueType.Shared]) {
            const distributedObject = await this.runtime.getChannel(remote.value);
            translatedValue = distributedObject;
        } else if (remote.type === ValueType[ValueType.Plain]) {
            translatedValue = remote.value;
        } else if (this.map.hasValueType(remote.type)) {
            const valueType = this.map.getValueType(remote.type);
            translatedValue = valueType.factory.load(new ValueOpEmitter(remote.type, key, this.map), remote.value);
        } else {
            return Promise.reject("Unknown value type");
        }

        return {
            localType: remote.type,
            localValue: translatedValue,
        };
    }

    private spill(local: ILocalViewElement): IMapValue {
        if (local.localType === ValueType[ValueType.Shared]) {
            const distributedObject = local.localValue as ISharedObject;

            // Attach the collab object to the document. If already attached the attach call will noop.
            // This feels slightly out of place here since it has a side effect. But is part of spilling a document.
            // Not sure if there is some kind of prep call to separate the op creation from things needed to make it
            // (like attaching)
            if (!this.map.isLocal()) {
                distributedObject.attach();
            }
            return {
                type: ValueType[ValueType.Shared],
                value: distributedObject.id,
            };
        } else if (this.map.hasValueType(local.localType)) {
            const valueType = this.map.getValueType(local.localType);
            return {
                type: local.localType,
                value: valueType.factory.store(local.localValue),
            };
        } else {
            return {
                type: ValueType[ValueType.Plain],
                value: local.localValue,
            };
        }
    }
}

export class DirectoryView extends MapView {
    constructor(directory: SharedDirectory, runtime: IComponentRuntime,
        id: string) {
        super(directory, runtime, id);
    }

}
