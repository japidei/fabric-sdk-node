/**
 * Copyright 2018, 2019 IBM All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';
const Contract = require('./contract');
const EventServiceManager = require('./impl/event/eventservicemanager');
const BlockEventListener = require('./impl/event/blockeventlistener');
const {CommitListenerSession} = require('./impl/event/commitlistener');

const logger = require('./logger').getLogger('Network');

/**
 * @typedef {Object} Network~EventListenerOptions
 * @private
 * @memberof module:fabric-network
 * @property {Object} checkpointer - a checkpointer instance
 * @property {boolean} [replay=false] - event replay on listener
 * @property {boolean} [filtered=true] - used to receive filtered block events or not
 * @property {boolean} [privateData=false] - when receiving full blocks (filtered=false)
 * include this user's private data, will be ignored when receiving filtered blocks and
 * will only include private data this user is allowed to see
 * @property {boolean} [unregister] - unregisters the listener after first event is received
 * @property {number} [startBlock] - the first block to play events
 * @property {number} [endBlock] - the final block to play events
 * @property {string} [transactionId] - the transactionId to monitor for commit
 * events. Only used for transaction commit events and will be ignored for other
 * event types. The default is to call the application commit event listener on
 * every transaction committed to the ledger.
 */

/**
 * A callback function that will be invoked when either a peer communication error occurs or a transaction commit event
 * is received. Only one of the two arguments will have a value for any given invocation.
 * @callback Network~CommitListener
 * @memberof module:fabric-network
 * @param {module:fabric-network.Network~CommitError} [error] Peer communication error.
 * @param {module:fabric-network.Network~CommitEvent} [event] Transaction commit event from a specific peer.
 */

/**
 * @typedef {Error} Network~CommitError
 * @memberof module:fabric-network
 * @property {Endorser} peer The peer that raised this error.
 */

/**
 * @typedef {EventInfo} Network~CommitEvent
 * @memberof module:fabric-network
 * @property {Endorser} peer The peer that raised this error.
 */

/**
 * A Network represents the set of peers in a Fabric network.
 * Applications should get a Network instance using the
 * gateway's [getNetwork]{@link module:fabric-network.Gateway#getNetwork} method.
 * @memberof module:fabric-network
 * @hideconstructor
 */
class Network {
	/*
	 * Network constructor for internal use only.
	 * @param {Gateway} gateway The owning gateway instance
	 * @param {Channel} channel The fabric-base channel instance
	 */
	constructor(gateway, channel) {
		const method = 'constructor';
		logger.debug('%s - start', method);

		this.gateway = gateway;
		this.channel = channel;
		this.contracts = new Map();
		this.initialized = false;
		this.listeners = new Map();
		this.discoveryService = null;
		this.queryHandler = null;
		this.eventServiceManager = null;
		this.commitListeners = new Map();
	}

	/**
	 * initialize the channel if it hasn't been done
	 * @private
	 */
	async _initializeInternalChannel(options) {
		const method = '_initializeInternalChannel';
		logger.debug('%s - start', method);

		if (options.enabled) {
			logger.debug('%s - initialize with discovery', method);
			let targets;
			if (options.targets) {
				if (Array.isArray(options.targets) && options.targets.length > 0) {
					for (const target of options.targets) {
						if (!target.connected) {
							throw Error(`Endorser instance ${target.name} is not connected to an endpoint`);
						}
					}
				} else {
					throw Error('No discovery targets found');
				}
				targets = options.targets;
				logger.debug('%s - user has specified discovery targets', method);
			} else {
				logger.debug('%s - user has not specified discovery targets, check channel and client', method);

				// maybe the channel has connected endorsers with the mspid
				const mspId = this.gateway.getIdentity().mspId;
				targets = this.channel.getEndorsers(mspId);
				if (!targets || targets.length < 1) {
					// then check the client for connected peers associated with the mspid
					targets = this.channel.client.getEndorsers(mspId);
				}
				if (!targets || targets.length < 1) {
					// get any peer
					targets = this.channel.client.getEndorsers();
				}

				if (!targets || targets.length < 1) {
					throw Error('No discovery targets found');
				} else {
					logger.debug('%s - using channel/client targets', method);
				}
			}

			// should have targets by now, create the discoverers from the endorsers
			const discoverers = [];
			for (const peer of targets) {
				const discoverer = this.channel.client.newDiscoverer(peer.name, peer.mspid);
				await discoverer.connect(peer.endpoint);
				discoverers.push(discoverer);
			}
			this.discoveryService = this.channel.newDiscoveryService(this.channel.name);
			const idx = this.gateway.identityContext;

			// do the three steps
			this.discoveryService.build(idx);
			this.discoveryService.sign(idx);
			logger.debug('%s - will discover asLocalhost:%s', method, options.asLocalhost);
			await this.discoveryService.send({
				asLocalhost: options.asLocalhost,
				targets: discoverers
			});

			// now we can work with the discovery results
			// or get a handler later from the discoverService
			// to be used on endorsement, queries, and commits
			logger.debug('%s - discovery complete - channel is populated', method);

		} else {
			this.discoveryService = null;
		}

		logger.debug('%s - end', method);
	}

	/**
	 * Initialize this network instance
	 * @private
	 */
	async _initialize(discover) {
		const method = '_initialize';
		logger.debug('%s - start', method);

		if (this.initialized) {
			return;
		}

		await this._initializeInternalChannel(discover);

		this.initialized = true;

		// Must be created after channel initialization to ensure discovery has located the peers
		const queryOptions = this.gateway.getOptions().query;
		this.queryHandler = queryOptions.strategy(this, queryOptions);
		this.eventServiceManager = new EventServiceManager(this);
		logger.debug('%s - end', method);
	}

	/**
	 * Get the owning Gateway connection.
	 * @returns {module:fabric-network.Gateway} A Gateway.
	 */
	getGateway() {
		return this.gateway;
	}

	/**
	 * Get an instance of a contract (chaincode) on the current network.
	 * @param {string} chaincodeId - the chaincode identifier.
	 * @param {string} [name] - the name of the contract.
	 * @param {string[]} [collections] - the names of collections defined for this chaincode.
	 * @returns {module:fabric-network.Contract} the contract.
	 */
	getContract(chaincodeId, name = '', collections) {
		const method = 'getContract';
		logger.debug('%s - start - name %s', method, name);

		if (!this.initialized) {
			throw new Error('Unable to get contract as this network has failed to initialize');
		}
		const key = `${chaincodeId}:${name}`;
		let contract = this.contracts.get(key);
		if (!contract) {
			contract = 	new Contract(
				this,
				chaincodeId,
				name,
				collections
			);
			this.contracts.set(key, contract);
		}
		return contract;
	}

	/**
	 * Get the underlying channel object representation of this network.
	 * @returns {Channel} A channel.
	 */
	getChannel() {
		return this.channel;
	}

	_dispose() {
		const method = '_dispose';
		logger.debug('%s - start', method);

		this.listeners.forEach(listener => listener.unregister());
		this.contracts.clear();

		this.eventServiceManager.dispose();
		this.channel.close();

		this.initialized = false;
	}

	/**
	 * Create a block event listener.
	 * @param {Function} callback - the function to be called when an event is
	 * triggered with signature (error, block)
	 * @param {module:fabric-network.Network~EventListenerOptions} [options] Optional.
	 * @param {EventService} [eventService] - Optional. Used to override the
	 * event service selection
	 * @returns {module:fabric-network~BlockEventListener}
	 * @async
	 * @private
	 */
	async addBlockListener(callback, options = {}, eventService) {
		const method = 'addBlockListener';
		logger.debug('%s - start', method);

		const listener = new BlockEventListener(this, callback, options);
		this.saveListener(listener, listener);
		if (eventService) {
			listener.eventService = eventService;
		}
		await listener.register();
		return listener;
	}

	/**
	 * Add a listener to receive transaction commit and peer disconnect events for a set of peers.
	 * @param {module:fabric-network.Network~CommitListener} listener A transaction commit listener callback function.
	 * @param {Endorser[]} peers The peers from which to receive events.
	 * @param {string} transactionId A transaction ID.
	 * @returns {module:fabric-network.Network~CommitListener} The added listener.
	 * @example
	 * const listener: CommitListener = (error, event) => {
	 *     if (error) {
	 *         // Handle peer communication error
	 *     } else {
	 *         // Handle transaction commit event
	 *     }
	 * }
	 * const peers = network.channel.getEndorsers();
	 * await network.addCommitListener(listener, peers, transactionId);
	 */
	async addCommitListener(listener, peers, transactionId) {
		if (!this.commitListeners.has(listener)) {
			const session = new CommitListenerSession(listener, this.eventServiceManager, peers, transactionId);
			// Store listener before starting in case start fires error events that trigger remove of the listener
			this.commitListeners.set(listener, session);
			await session.start();
		}
		return listener;
	}

	/**
	 * Removes a previously added transaction commit listener.
	 * @param {module:fabric-network.Network~CommitListener} listener A transaction commit listener callback function.
	 */
	removeCommitListener(listener) {
		const session = this.commitListeners.get(listener);
		if (session) {
			session.close();
			this.commitListeners.delete(listener);
		}
	}

	/*
	 * Save the listener to a map in Network
	 * @param {String} listenerName the name of the listener being saved
	 * @param {AbstractEventListener} listener the listener to be saved
	 * @private
	 */
	saveListener(listenerName, listener) {
		const method = 'saveListener';
		logger.debug('%s - start', method);

		this.listeners.set(listenerName, listener);
	}
}

module.exports = Network;
