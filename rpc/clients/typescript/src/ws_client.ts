import { assert } from '@0x/assert';
import { orderParsingUtils } from '@0x/order-utils';
import { ObjectMap, SignedOrder } from '@0x/types';
import { BigNumber } from '@0x/utils';
import { v4 as uuid } from 'uuid';
import * as WebSocket from 'websocket';

import {
    AcceptedOrderInfo,
    GetOrdersResponse,
    HeartbeatEventPayload,
    OrderEvent,
    OrderEventPayload,
    RawAcceptedOrderInfo,
    RawOrderEvent,
    RawValidationResults,
    RejectedOrderInfo,
    ValidationResults,
    WSOpts,
} from './types';
import { WebSocketProvider } from './websocket_provider';

const CLOSE_REASON_NO_HEARTBEAT = 3001;
const CLOSE_DESCRIPTION_NO_HEARTBEAT = 'No heartbeat received';
const CLEAR_SUBSCRIPTIONS_GRACE_PERIOD_MS = 100;

const DEFAULT_RECONNECT_AFTER_MS = 5000;
const DEFAULT_WS_OPTS = {
    clientConfig: {
        // For some reason fragmenting the payloads causes the connection to close
        // Source: https://github.com/theturtle32/WebSocket-Node/issues/359
        fragmentOutgoingMessages: false,
    },
    reconnectAfter: DEFAULT_RECONNECT_AFTER_MS,
};

/**
 * This class includes all the functionality related to interacting with a Mesh JSON RPC
 * websocket endpoint.
 */
export class WSClient {
    private readonly _subscriptionIdToMeshSpecificId: ObjectMap<string>;
    private _heartbeatCheckIntervalId: number | undefined;
    private readonly _wsProvider: WebSocketProvider;
    private static _convertRawAcceptedOrders(rawAcceptedOrders: RawAcceptedOrderInfo[]): AcceptedOrderInfo[] {
        const acceptedOrderInfos: AcceptedOrderInfo[] = [];
        rawAcceptedOrders.forEach(rawAcceptedOrderInfo => {
            const acceptedOrderInfo: AcceptedOrderInfo = {
                orderHash: rawAcceptedOrderInfo.orderHash,
                signedOrder: orderParsingUtils.convertOrderStringFieldsToBigNumber(rawAcceptedOrderInfo.signedOrder),
                fillableTakerAssetAmount: new BigNumber(rawAcceptedOrderInfo.fillableTakerAssetAmount),
            };
            acceptedOrderInfos.push(acceptedOrderInfo);
        });
        return acceptedOrderInfos;
    }
    /**
     * Instantiates a new WSClient instance
     * @param   url               WS server endpoint
     * @param   wsOpts            WebSocket options
     * @return  An instance of WSClient
     */
    constructor(url: string, wsOpts?: WSOpts) {
        this._subscriptionIdToMeshSpecificId = {};
        if (wsOpts !== undefined && wsOpts.reconnectAfter === undefined) {
            wsOpts.reconnectAfter = DEFAULT_RECONNECT_AFTER_MS;
        }
        this._wsProvider = createWebsocketProvider(
            url,
            wsOpts !== undefined ? (wsOpts as any) : DEFAULT_WS_OPTS,
        );
        // Intentional fire-and-forget
        // tslint:disable-next-line:no-floating-promises
        this._startInternalLivenessCheckAsync();
    }
    /**
     * Adds an array of 0x signed orders to the Mesh node.
     * @param signedOrders signedOrders to add
     * @returns validation results
     */
    public async addOrdersAsync(signedOrders: SignedOrder[]): Promise<ValidationResults> {
        assert.isArray('signedOrders', signedOrders);
        const rawValidationResults: RawValidationResults = await this._wsProvider.sendAsync('mesh_addOrders', [
            signedOrders,
        ]);
        const validationResults: ValidationResults = {
            accepted: WSClient._convertRawAcceptedOrders(rawValidationResults.accepted),
            rejected: [],
        };
        rawValidationResults.rejected.forEach(rawRejectedOrderInfo => {
            const rejectedOrderInfo: RejectedOrderInfo = {
                orderHash: rawRejectedOrderInfo.orderHash,
                signedOrder: orderParsingUtils.convertOrderStringFieldsToBigNumber(rawRejectedOrderInfo.signedOrder),
                kind: rawRejectedOrderInfo.kind,
                status: rawRejectedOrderInfo.status,
            };
            validationResults.rejected.push(rejectedOrderInfo);
        });
        return validationResults;
    }
    /**
     * Get all 0x signed orders currently stored in the Mesh node
     * @param perPage number of signedOrders to fetch per paginated request
     * @returns all orders, their hash and their fillableTakerAssetAmount
     */
    public async getOrdersAsync(perPage: number = 200): Promise<AcceptedOrderInfo[]> {
        let snapshotID = ''; // New snapshot

        let page = 0;
        const getOrdersResponse: GetOrdersResponse = await this._wsProvider.sendAsync('mesh_getOrders',
            [
                page,
                perPage,
                snapshotID,
            ],
        );
        snapshotID = getOrdersResponse.snapshotID;
        let ordersInfos = getOrdersResponse.ordersInfos;

        let rawAcceptedOrderInfos: RawAcceptedOrderInfo[] = [];
        do {
            rawAcceptedOrderInfos = [...rawAcceptedOrderInfos, ...ordersInfos];
            page++;
            ordersInfos = (await this._wsProvider.sendAsync('mesh_getOrders', [page, perPage, snapshotID]))
                .ordersInfos;
        } while (Object.keys(ordersInfos).length > 0);

        const allOrdersInfos = WSClient._convertRawAcceptedOrders(rawAcceptedOrderInfos);
        return allOrdersInfos;
    }
    /**
     * Subscribe to the 'orders' topic and receive order events from Mesh. This method returns a
     * subscriptionId that can be used to `unsubscribeAsync()` from this subscription.
     * @param   cb   callback function where you'd like to get notified about order events
     * @return subscriptionId
     */
    public async subscribeToOrdersAsync(cb: (orderEvents: OrderEvent[]) => void): Promise<string> {
        assert.isFunction('cb', cb);
        const orderEventsSubscriptionId = await this._wsProvider.subscribeAsync('mesh_subscribe', 'orders', []);
        const id = uuid();
        this._subscriptionIdToMeshSpecificId[id] = orderEventsSubscriptionId;

        const orderEventsCallback = (eventPayload: OrderEventPayload) => {
            this._subscriptionIdToMeshSpecificId[id] = eventPayload.subscription;
            const rawOrderEvents: RawOrderEvent[] = eventPayload.result;
            const orderEvents: OrderEvent[] = [];
            rawOrderEvents.forEach(rawOrderEvent => {
                const orderEvent = {
                    orderHash: rawOrderEvent.orderHash,
                    signedOrder: orderParsingUtils.convertOrderStringFieldsToBigNumber(rawOrderEvent.signedOrder),
                    kind: rawOrderEvent.kind,
                    fillableTakerAssetAmount: new BigNumber(rawOrderEvent.fillableTakerAssetAmount),
                    txHashes: rawOrderEvent.txHashes,
                };
                orderEvents.push(orderEvent);
            });
            cb(orderEvents);
        };
        this._wsProvider.on(orderEventsSubscriptionId, orderEventsCallback as any);
        return id;
    }
    /**
     * Unsubscribe from a subscription
     * @param subscriptionId identifier of the subscription to cancel
     */
    public async unsubscribeAsync(subscriptionId: string): Promise<void> {
        assert.isString('subscriptionId', subscriptionId);
        const meshSubscriptionId = this._subscriptionIdToMeshSpecificId[subscriptionId];
        if (meshSubscriptionId === undefined) {
            throw new Error(`Subscription not found with ID: ${subscriptionId}`);
        }
        await this._wsProvider.unsubscribeAsync(meshSubscriptionId, 'mesh_unsubscribe');
    }
    /**
     * Get notified when the underlying WS connection closes normally. If it closes with an
     * error, WSClient automatically attempts to re-connect without emitting a `close` event.
     * @param cb callback to call when WS connection closes
     */
    public onClose(cb: () => void): void {
        this._wsProvider.connection.addEventListener('close', () => {
            cb();
        });
    }
    /**
     * Get notified when a connection to the underlying WS connection is re-established
     * @param cb callback to call with the error when it occurs
     */
    public onReconnected(cb: () => void): void {
        this._wsProvider.on('reconnected', () => {
            cb();
        });
    }
    /**
     * destroy unsubscribes all active subscriptions, closes the websocket connection
     * and stops the internal heartbeat connection liveness check.
     */
    public async destroyAsync(): Promise<void> {
        clearInterval(this._heartbeatCheckIntervalId);
        // HACK(fabio): We fire-and-forget the call to clear subscriptions since we don't want `destroyAsync()`
        // to block if the connection is having issues. The hacky part though is that we will get an error if
        // we try to send a payload on a connection _we know_ is closed. We therefore need to call `disconnect`
        // after a timeout so that we are sure we've already attempted to send the unsubscription payloads before
        // we forcefully close the connection
        this._wsProvider.clearSubscriptionsAsync('mesh_unsubscribe');
        await new Promise<NodeJS.Timer>(resolve => setTimeout(resolve, CLEAR_SUBSCRIPTIONS_GRACE_PERIOD_MS));
        this._wsProvider.disconnect(WebSocket.connection.CLOSE_REASON_NORMAL, 'Normal connection closure');
    }
    /**
     * Subscribe to the 'heartbeat' topic and receive an ack from the Mesh every 5 seconds. This method
     * returns a subscriptionId that can be used to `unsubscribeAsync()` from this subscription.
     * @param   cb   callback function where you'd like to get notified about heartbeats
     * @return subscriptionId
     */
    private async _subscribeToHeartbeatAsync(cb: (ack: string) => void): Promise<string> {
        assert.isFunction('cb', cb);
        const heartbeatSubscriptionId = await this._wsProvider.subscribeAsync('mesh_subscribe', 'heartbeat', []);
        const id = uuid();
        this._subscriptionIdToMeshSpecificId[id] = heartbeatSubscriptionId;

        const orderEventsCallback = (eventPayload: HeartbeatEventPayload) => {
            this._subscriptionIdToMeshSpecificId[id] = eventPayload.subscription;
            cb(eventPayload.result);
        };
        this._wsProvider.on(heartbeatSubscriptionId, orderEventsCallback as any);
        return id;
    }
    private async _startInternalLivenessCheckAsync(): Promise<void> {
        let lastHeartbeatTimestampMs = new Date().getTime();
        try {
            await this._subscribeToHeartbeatAsync((ack: string) => {
                lastHeartbeatTimestampMs = new Date().getTime();
            });
        } catch (err) {
            throw new Error('Failed to establish under-the-hood heartbeat subscription');
        }
        const oneSecondInMs = 1000;
        this._heartbeatCheckIntervalId = setInterval(() => {
            const twentySecondsInMs = 20000;
            // tslint:disable-next-line:boolean-naming
            const haveTwentySecondsPastWithoutAHeartBeat =
                lastHeartbeatTimestampMs + twentySecondsInMs < new Date().getTime();
            if (haveTwentySecondsPastWithoutAHeartBeat) {
                // If connected, we haven't received a heartbeat in over 20 seconds, re-connect
                if (this._wsProvider.isConnected()) {
                    this._wsProvider.disconnect(CLOSE_REASON_NO_HEARTBEAT, CLOSE_DESCRIPTION_NO_HEARTBEAT);
                }
                lastHeartbeatTimestampMs = new Date().getTime();
            }
        }, oneSecondInMs) as any;
    }
}

/**
 * Return an WebsocketProvider object
 * @param url WebSocket endpoint
 * @param options WebSocket options
 * @returns A WebSocketProvider instance
 */
function createWebsocketProvider(url: string, options: WSOpts = {}): WebSocketProvider {
        let connection = '';

        // runtime is of type node
        if (typeof process !== 'undefined' && process.versions != null && process.versions.node != null) {
            const headers: any = options.headers || {};
            const urlObject = new URL(url);

            if (!headers.authorization && urlObject.username && urlObject.password) {
                const authToken = Buffer.from(`${urlObject.username}:${urlObject.password}`).toString('base64');
                headers.authorization = `Basic ${authToken}`;
            }

            connection = new (WebSocket.w3cwebsocket as any)(url, options.protocol, null, headers, null, options.clientConfig);
        } else {
            connection = new (window as any).WebSocket(url, options.protocol);
        }

        return new WebSocketProvider(connection, options.reconnectAfter, options.timeout);
    }
