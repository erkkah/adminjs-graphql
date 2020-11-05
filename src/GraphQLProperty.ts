import { PropertyType, BaseProperty } from "admin-bro";

interface BasePropertyAttrs {
    path: string;
    type?: PropertyType;
    isId?: boolean;
    isSortable?: boolean;
    position?: number;
}

export class GraphQLPropertyAdapter extends BaseProperty {
    private _subProperties: BaseProperty[] = [];
    private _referencing?: string;
    private _enumValues?: string[];
    private _isArray?: boolean;
    private _isRequired?: boolean;

    constructor(property: BasePropertyAttrs & {
        referencing?: string;
        enumValues?: string[];
        isArray?: boolean,
        isRequired?: boolean,
    }) {
        super(property);
        this._referencing = property.referencing;
        this._enumValues = property.enumValues;
        this._isArray = property.isArray;
        this._isRequired = property.isRequired;
    }

    setSubProperties(properties: BaseProperty[]): void {
        this._subProperties = properties;
    }

    subProperties(): BaseProperty[] {
        return this._subProperties;
    }

    reference(): string | null {
        return this._referencing || null;
    }

    availableValues(): string[] | null {
        return this._enumValues ?? super.availableValues();
    }

    isArray(): boolean {
        return this._isArray ?? false;
    }

    isRequired(): boolean {
        return this._isRequired ?? false;
    }

}
