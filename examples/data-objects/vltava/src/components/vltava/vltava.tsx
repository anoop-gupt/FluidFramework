/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { DataObject, DataObjectFactory } from "@fluidframework/aqueduct";
import { IFluidHTMLView } from "@fluidframework/view-interfaces";

import React from "react";
import ReactDOM from "react-dom";

import { IVltavaDataModel, VltavaDataModel } from "./dataModel";
import { VltavaView } from "./view";

export const VltavaName = "vltava";

/**
 * Vltava is an application experience
 */
export class Vltava extends DataObject implements IFluidHTMLView {
    private dataModelInternal: IVltavaDataModel | undefined;

    private static readonly factory = new DataObjectFactory(VltavaName, Vltava, [], {});

    public static getFactory() {
        return Vltava.factory;
    }

    private get dataModel(): IVltavaDataModel {
        if (!this.dataModelInternal) {
            throw new Error("The Vltava DataModel was not properly initialized.");
        }

        return this.dataModelInternal;
    }

    public get IFluidHTMLView() { return this; }

    protected async initializingFirstTime() {
        const tabsComponent = await this.createFluidObject("tabs");
        this.root.set("tabs-component-id", tabsComponent.handle);
    }

    protected async hasInitialized() {
        this.dataModelInternal =
            new VltavaDataModel(
                this.root,
                this.context,
                this.runtime);
    }

    /**
     * Will return a new Vltava View
     */
    public render(div: HTMLElement) {
        ReactDOM.render(
            <VltavaView dataModel={this.dataModel} />,
            div);
    }
}