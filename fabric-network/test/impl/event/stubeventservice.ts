/**
 * Copyright 2020 IBM All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import {
	Eventer,
	EventCallback,
	EventListener,
	EventRegistrationOptions,
	EventService,
	IdentityContext,
	ServiceAction,
	EventInfo
} from 'fabric-common';
import Long = require('long');

// tslint:disable:max-classes-per-file

interface TransactionListenerInfo {
	readonly transactionId: string;
	readonly callback: EventCallback;
	readonly options: EventRegistrationOptions;
}

class StubTransactionEventListener implements EventListener {
	readonly transactionId: string;
	readonly callback: EventCallback;
	readonly options: EventRegistrationOptions;
	private readonly eventService: EventService;

	constructor(eventService: EventService, transactionId: string, callback: EventCallback, options: EventRegistrationOptions) {
		this.eventService = eventService;
		this.transactionId = transactionId;
		this.callback = callback;
		this.options = options;
	}

	onEvent(error: Error, event: EventInfo) {
		if (error || event.transactionId === this.transactionId) {
			if (this.options.unregister !== false) {
				this.unregisterEventListener();
			}
			this.callback(error, event);
		}
	}

	unregisterEventListener() {
		this.eventService.unregisterEventListener(this);
	}
}

export class StubEventService implements EventService {
	readonly name: string;
	startBlock: string | Long;
	endBlock: string | Long;

	readonly eventListeners = new Set<EventListener>();

	constructor(name: string) {
		this.name = name;
	}

	setEventer(discoverer: Eventer): EventService {
		throw new Error('Method not implemented.');
	}

	getLastBlockNumber(): Long {
		throw new Error('Method not implemented.');
	}

	close() {
		throw new Error('Method not implemented.');
	}

	build(idContext: IdentityContext, request: any): Buffer {
		throw new Error('Method not implemented.');
	}

	send(request: any): Promise<any> {
		throw new Error('Method not implemented.');
	}

	isListening(): boolean {
		throw new Error('Method not implemented.');
	}

	unregisterEventListener(eventListener: EventListener): EventService {
		const removed = this.eventListeners.delete(eventListener);
		if (!removed) {
			throw new Error('unregisterEventLister called for listener that is not registered');
		}
		return this;
	}

	registerTransactionListener(txid: string, callback: EventCallback, options: EventRegistrationOptions): EventListener {
		const listener = new StubTransactionEventListener(this, txid, callback, options);
		this.eventListeners.add(listener);
		return listener;
	}

	registerChaincodeListener(eventName: string, callback: EventCallback, options: EventRegistrationOptions): import('fabric-common').EventListener {
		throw new Error('Method not implemented.');
	}

	registerBlockListener(callback: EventCallback, options: EventRegistrationOptions): EventListener {
		throw new Error('Method not implemented.');
	}

	sign(parm: IdentityContext | Buffer): ServiceAction {
		throw new Error('Method not implemented.');
	}

	getSignedProposal() {
		throw new Error('Method not implemented.');
	}

	getSignedEnvelope() {
		throw new Error('Method not implemented.');
	}

	sendEvent(event: EventInfo) {
		this.eventListeners.forEach((listener) => listener.onEvent(undefined, event));
	}

	sendError(error: Error) {
		this.eventListeners.forEach((listener) => listener.onEvent(error, undefined));
	}
}
