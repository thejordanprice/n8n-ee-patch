"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.License = void 0;
const config_1 = require("@n8n/config");
const constants_1 = require("@n8n/constants");
const db_1 = require("@n8n/db");
const decorators_1 = require("@n8n/decorators");
const di_1 = require("@n8n/di");
const license_sdk_1 = require("@n8n_io/license-sdk");
const n8n_core_1 = require("n8n-core");
const config_2 = __importDefault(require("./config"));
const license_metrics_service_1 = require("./metrics/license-metrics.service");
const constants_2 = require("./constants");
const LICENSE_RENEWAL_DISABLED_WARNING = 'Automatic license renewal is disabled. The license will not renew automatically, and access to licensed features may be lost!';
let License = class License {
    constructor(logger, instanceSettings, settingsRepository, licenseMetricsService, globalConfig) {
        this.logger = logger;
        this.instanceSettings = instanceSettings;
        this.settingsRepository = settingsRepository;
        this.licenseMetricsService = licenseMetricsService;
        this.globalConfig = globalConfig;
        this.isShuttingDown = false;
        this.logger = this.logger.scoped('license');
    }
    async init({ forceRecreate = false, isCli = false, } = {}) {
        if (this.manager && !forceRecreate) {
            this.logger.warn('License manager already initialized or shutting down');
            return;
        }
        if (this.isShuttingDown) {
            this.logger.warn('License manager already shutting down');
            return;
        }
        const { instanceType } = this.instanceSettings;
        const isMainInstance = instanceType === 'main';
        const server = this.globalConfig.license.serverUrl;
        const offlineMode = !isMainInstance;
        const autoRenewOffset = 72 * constants_2.Time.hours.toSeconds;
        const saveCertStr = isMainInstance
            ? async (value) => await this.saveCertStr(value)
            : async () => { };
        const onFeatureChange = isMainInstance
            ? async (features) => await this.onFeatureChange(features)
            : async () => { };
        const collectUsageMetrics = isMainInstance
            ? async () => await this.licenseMetricsService.collectUsageMetrics()
            : async () => [];
        const collectPassthroughData = isMainInstance
            ? async () => await this.licenseMetricsService.collectPassthroughData()
            : async () => ({});
        const { isLeader } = this.instanceSettings;
        const { autoRenewalEnabled } = this.globalConfig.license;
        const eligibleToRenew = isCli || isLeader;
        const shouldRenew = eligibleToRenew && autoRenewalEnabled;
        if (eligibleToRenew && !autoRenewalEnabled) {
            this.logger.warn(LICENSE_RENEWAL_DISABLED_WARNING);
        }
        try {
            this.manager = new license_sdk_1.LicenseManager({
                server,
                tenantId: this.globalConfig.license.tenantId,
                productIdentifier: `n8n-${constants_2.N8N_VERSION}`,
                autoRenewEnabled: shouldRenew,
                renewOnInit: shouldRenew,
                autoRenewOffset,
                detachFloatingOnShutdown: this.globalConfig.license.detachFloatingOnShutdown,
                offlineMode,
                logger: this.logger,
                loadCertStr: async () => await this.loadCertStr(),
                saveCertStr,
                deviceFingerprint: () => this.instanceSettings.instanceId,
                collectUsageMetrics,
                collectPassthroughData,
                onFeatureChange,
            });
            await this.manager.initialize();
            const features = this.manager.getFeatures();
            this.checkIsLicensedForMultiMain(features);
            this.logger.debug('License initialized');
        }
        catch (error) {
            if (error instanceof Error) {
                this.logger.error('Could not initialize license manager sdk', { error });
            }
        }
    }
    async loadCertStr() {
        const ephemeralLicense = this.globalConfig.license.cert;
        if (ephemeralLicense) {
            return ephemeralLicense;
        }
        const databaseSettings = await this.settingsRepository.findOne({
            where: {
                key: constants_2.SETTINGS_LICENSE_CERT_KEY,
            },
        });
        return databaseSettings?.value ?? '';
    }
    async onFeatureChange(_features) {
        const { isMultiMain, isLeader } = this.instanceSettings;
        if (Object.keys(_features).length === 0) {
            this.logger.error('Empty license features recieved', { isMultiMain, isLeader });
            return;
        }
        this.logger.debug('License feature change detected', _features);
        this.checkIsLicensedForMultiMain(_features);
        if (isMultiMain && !isLeader) {
            this.logger
                .scoped(['scaling', 'multi-main-setup', 'license'])
                .debug('Instance is not leader, skipping sending of "reload-license" command...');
            return;
        }
        if (config_2.default.getEnv('executions.mode') === 'queue') {
            const { Publisher } = await Promise.resolve().then(() => __importStar(require('./scaling/pubsub/publisher.service')));
            await di_1.Container.get(Publisher).publishCommand({ command: 'reload-license' });
        }
    }
    async saveCertStr(value) {
        if (this.globalConfig.license.cert)
            return;
        await this.settingsRepository.upsert({
            key: constants_2.SETTINGS_LICENSE_CERT_KEY,
            value,
            loadOnStartup: false,
        }, ['key']);
    }
    async activate(activationKey) {
        if (!this.manager) {
            return;
        }
        await this.manager.activate(activationKey);
        this.logger.debug('License activated');
    }
    async reload() {
        if (!this.manager) {
            return;
        }
        await this.manager.reload();
        this.logger.debug('License reloaded');
    }
    async renew() {
        if (!this.manager) {
            return;
        }
        await this.manager.renew();
        this.logger.debug('License renewed');
    }
    async clear() {
        if (!this.manager) {
            return;
        }
        await this.manager.clear();
        this.logger.info('License cleared');
    }
    async shutdown() {
        this.isShuttingDown = true;
        if (!this.manager) {
            return;
        }
        await this.manager.shutdown();
        this.logger.debug('License shut down');
    }
    isLicensed(feature) {
        return true;
    }
    isSharingEnabled() {
        return true;
    }
    isLogStreamingEnabled() {
        return true;
    }
    isLdapEnabled() {
        return true;
    }
    isSamlEnabled() {
        return true;
    }
    isApiKeyScopesEnabled() {
        return true;
    }
    isAiAssistantEnabled() {
        return true;
    }
    isAskAiEnabled() {
        return true;
    }
    isAiCreditsEnabled() {
        return true;
    }
    isAdvancedExecutionFiltersEnabled() {
        return true;
    }
    isAdvancedPermissionsLicensed() {
        return true;
    }
    isDebugInEditorLicensed() {
        return true;
    }
    isBinaryDataS3Licensed() {
        return true;
    }
    isMultiMainLicensed() {
        return true;
    }
    isVariablesEnabled() {
        return this.isLicensed(constants_1.LICENSE_FEATURES.VARIABLES);
    }
    isSourceControlLicensed() {
        return true;
    }
    isExternalSecretsEnabled() {
        return true;
    }
    isWorkflowHistoryLicensed() {
        return true;
    }
    isAPIDisabled() {
        return false;
    }
    isWorkerViewLicensed() {
        return true;
    }
    isProjectRoleAdminLicensed() {
        return true;
    }
    isProjectRoleEditorLicensed() {
        return true;
    }
    isProjectRoleViewerLicensed() {
        return true;
    }
    isCustomNpmRegistryEnabled() {
        return true;
    }
    isFoldersEnabled() {
        return true;
    }
    isProductionLicensed() {
        return true;
    }
    getCurrentEntitlements() {
        return {
            features: {
                [constants_1.LICENSE_FEATURES.SHARING]: true,
                [constants_1.LICENSE_FEATURES.LOG_STREAMING]: true,
                [constants_1.LICENSE_FEATURES.LDAP]: true,
                [constants_1.LICENSE_FEATURES.SAML]: true,
                [constants_1.LICENSE_FEATURES.API_KEY_SCOPES]: true,
                [constants_1.LICENSE_FEATURES.AI_ASSISTANT]: true,
                [constants_1.LICENSE_FEATURES.ASK_AI]: true,
                [constants_1.LICENSE_FEATURES.AI_CREDITS]: true,
                [constants_1.LICENSE_FEATURES.ADVANCED_EXECUTION_FILTERS]: true,
                [constants_1.LICENSE_FEATURES.ADVANCED_PERMISSIONS]: true,
                [constants_1.LICENSE_FEATURES.DEBUG_IN_EDITOR]: true,
                [constants_1.LICENSE_FEATURES.BINARY_DATA_S3]: true,
                [constants_1.LICENSE_FEATURES.MULTIPLE_MAIN_INSTANCES]: true,
                [constants_1.LICENSE_FEATURES.SOURCE_CONTROL]: true,
                [constants_1.LICENSE_FEATURES.EXTERNAL_SECRETS]: true,
                [constants_1.LICENSE_FEATURES.WORKFLOW_HISTORY]: true,
                [constants_1.LICENSE_FEATURES.WORKER_VIEW]: true,
                [constants_1.LICENSE_FEATURES.PROJECT_ROLE_ADMIN]: true,
                [constants_1.LICENSE_FEATURES.PROJECT_ROLE_EDITOR]: true,
                [constants_1.LICENSE_FEATURES.PROJECT_ROLE_VIEWER]: true,
                [constants_1.LICENSE_FEATURES.CUSTOM_NPM_REGISTRY]: true,
                [constants_1.LICENSE_FEATURES.FOLDERS]: true
            }
        };
    }
    getValue(feature) {
        return 999999;
    }
    getManagementJwt() {
        return 'enterprise-jwt-token';
    }
    getMainPlan() {
        return {
            productId: 'enterprise',
            name: 'Enterprise',
            features: this.getCurrentEntitlements().features
        };
    }
    getConsumerId() {
        return this.manager?.getConsumerId() ?? 'unknown';
    }
    getUsersLimit() {
        return 999999;
    }
    getTriggerLimit() {
        return 999999;
    }
    getVariablesLimit() {
        return 999999;
    }
    getAiCredits() {
        return 999999;
    }
    getWorkflowHistoryPruneLimit() {
        return 999999;
    }
    getTeamProjectLimit() {
        return 999999;
    }
    getPlanName() {
        return 'Enterprise';
    }
    getInfo() {
        if (!this.manager) {
            return 'n/a';
        }
        return this.manager.toString();
    }
    isWithinUsersLimit() {
        return this.getUsersLimit() === constants_1.UNLIMITED_LICENSE_QUOTA;
    }
    checkIsLicensedForMultiMain(features) {
        const isMultiMainEnabled = config_2.default.getEnv('executions.mode') === 'queue' && this.globalConfig.multiMainSetup.enabled;
        if (!isMultiMainEnabled) {
            return;
        }
        const isMultiMainLicensed = features[constants_1.LICENSE_FEATURES.MULTIPLE_MAIN_INSTANCES] ?? false;
        this.instanceSettings.setMultiMainLicensed(isMultiMainLicensed);
        if (!isMultiMainLicensed) {
            this.logger
                .scoped(['scaling', 'multi-main-setup', 'license'])
                .debug('License changed with no support for multi-main setup - no new followers will be allowed to init. To restore multi-main setup, please upgrade to a license that supports this feature.');
        }
    }
    enableAutoRenewals() {
        this.manager?.enableAutoRenewals();
    }
    disableAutoRenewals() {
        this.manager?.disableAutoRenewals();
    }
};
exports.License = License;
__decorate([
    (0, decorators_1.OnShutdown)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], License.prototype, "shutdown", null);
__decorate([
    (0, decorators_1.OnLeaderTakeover)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], License.prototype, "enableAutoRenewals", null);
__decorate([
    (0, decorators_1.OnLeaderStepdown)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], License.prototype, "disableAutoRenewals", null);
exports.License = License = __decorate([
    (0, di_1.Service)(),
    __metadata("design:paramtypes", [n8n_core_1.Logger,
        n8n_core_1.InstanceSettings,
        db_1.SettingsRepository,
        license_metrics_service_1.LicenseMetricsService,
        config_1.GlobalConfig])
], License);