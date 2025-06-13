import { eventSource, event_types, main_api, stopGeneration } from '../../../../script.js';
import { t } from '../../../i18n.js';
import { extension_settings } from '../../../extensions.js';
import { characters, substituteParams, substituteParamsExtended, this_chid } from '../../../../script.js';
import { regexFromString } from '../../../utils.js';

/**
 * @enum {number} Where the regex script should be applied
 */
const regex_placement = {
    /**
     * @deprecated MD Display is deprecated. Do not use.
     */
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    // 4 - sendAs (legacy)
    WORLD_INFO: 5,
    REASONING: 6,
};

export const substitute_find_regex = {
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
};

function sanitizeRegexMacro(x) {
    return (x && typeof x === 'string') ?
        x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, function (s) {
            switch (s) {
                case '\n':
                    return '\\n';
                case '\r':
                    return '\\r';
                case '\t':
                    return '\\t';
                case '\v':
                    return '\\v';
                case '\f':
                    return '\\f';
                case '\0':
                    return '\\0';
                default:
                    return '\\' + s;
            }
        }) : x;
}

function getScopedRegex() {
    const isAllowed = extension_settings?.character_allowed_regex?.includes(characters?.[this_chid]?.avatar);

    if (!isAllowed) {
        return [];
    }

    const scripts = characters[this_chid]?.data?.extensions?.regex_scripts;

    if (!Array.isArray(scripts)) {
        return [];
    }

    return scripts;
}


/**
 * Parent function to fetch a regexed version of a raw string
 * @param {string} rawString The raw string to be regexed
 * @param {regex_placement} placement The placement of the string
 * @param {RegexParams} params The parameters to use for the regex script
 * @returns {string} The regexed string
 * @typedef {{characterOverride?: string, isMarkdown?: boolean, isPrompt?: boolean, isEdit?: boolean, depth?: number }} RegexParams The parameters to use for the regex script
 */
function getRegexedString(rawString, placement, { characterOverride, isMarkdown, isPrompt, isEdit, depth } = {}) {
    // WTF have you passed me?
    if (typeof rawString !== 'string') {
        console.warn('getRegexedString: rawString is not a string. Returning empty string.');
        return '';
    }

    let finalString = rawString;
    if (extension_settings.disabledExtensions.includes('regex') || !rawString || placement === undefined) {
        return finalString;
    }

    const allRegex = [...(extension_settings.regex ?? []), ...(getScopedRegex() ?? [])];
    allRegex.forEach((script) => {
        if (
            // Script applies to Markdown and input is Markdown
            (script.markdownOnly && isMarkdown) ||
            // Script applies to Generate and input is Generate
            (script.promptOnly && isPrompt) ||
            // Script applies to all cases when neither "only"s are true, but there's no need to do it when `isMarkdown`, the as source (chat history) should already be changed beforehand
            (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt)
        ) {
            if (isEdit && !script.runOnEdit) {
                console.debug(`getRegexedString: Skipping script ${script.scriptName} because it does not run on edit`);
                return;
            }

            // Check if the depth is within the min/max depth
            if (typeof depth === 'number') {
                if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) {
                    console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is less than minDepth ${script.minDepth}`);
                    return;
                }

                if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) {
                    console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${depth} is greater than maxDepth ${script.maxDepth}`);
                    return;
                }
            }

            if (script.placement.includes(placement)) {
                finalString = runRegexScript(script, finalString, { characterOverride });
            }
        }
    });

    return finalString;
}

/**
 * Runs the provided regex script on the given string
 * @param {import('../../../extensions/regex/index.js').RegexScript} regexScript The regex script to run
 * @param {string} rawString The string to run the regex script on
 * @param {RegexScriptParams} params The parameters to use for the regex script
 * @returns {string} The new string
 * @typedef {{characterOverride?: string}} RegexScriptParams The parameters to use for the regex script
 */
function runRegexScript(regexScript, rawString, { characterOverride } = {}) {
    let newString = rawString;
    if (!regexScript || !!(regexScript.disabled) || !regexScript?.findRegex || !rawString) {
        return newString;
    }

    const getRegexString = () => {
        switch (Number(regexScript.substituteRegex)) {
            case substitute_find_regex.NONE:
                return regexScript.findRegex;
            case substitute_find_regex.RAW:
                return substituteParamsExtended(regexScript.findRegex);
            case substitute_find_regex.ESCAPED:
                return substituteParamsExtended(regexScript.findRegex, {}, sanitizeRegexMacro);
            default:
                console.warn(`runRegexScript: Unknown substituteRegex value ${regexScript.substituteRegex}. Using raw regex.`);
                return regexScript.findRegex;
        }
    };
    const regexString = getRegexString();
    const findRegex = regexFromString(regexString);

    // The user skill issued. Return with nothing.
    if (!findRegex) {
        return newString;
    }

    // Run replacement. Currently does not support the Overlay strategy
    newString = rawString.replace(findRegex, function (match) {
        const args = [...arguments];
        const replaceString = regexScript.replaceString.replace(/{{match}}/gi, '$0');
        const replaceWithGroups = replaceString.replaceAll(/\$(\d+)/g, (_, num) => {
            // Get a full match or a capture group
            const match = args[Number(num)];

            // No match found - return the empty string
            if (!match) {
                return '';
            }

            // Remove trim strings from the match
            const filteredMatch = filterString(match, regexScript.trimStrings, { characterOverride });

            // TODO: Handle overlay here

            return filteredMatch;
        });

        // Substitute at the end
        return substituteParams(replaceWithGroups);
    });

    return newString;
}

/**
 * Filters anything to trim from the regex match
 * @param {string} rawString The raw string to filter
 * @param {string[]} trimStrings The strings to trim
 * @param {RegexScriptParams} params The parameters to use for the regex filter
 * @returns {string} The filtered string
 */
function filterString(rawString, trimStrings, { characterOverride } = {}) {
    let finalString = rawString;
    trimStrings.forEach((trimString) => {
        const subTrimString = substituteParams(trimString, undefined, characterOverride);
        finalString = finalString.replaceAll(subTrimString, '');
    });

    return finalString;
}

/* ---------- helpers ---------------------------------------------------- */

/**
 * Collect the script-objects seen by getRegexedString() and
 * return an array of their human-readable names.
 * @returns {string[]}
 */
function getActiveRegexScripts() {
    // Global Regex scripts from settings
    const global = extension_settings.regex ?? [];

    // Merge, drop disabled, map to name
    return [...global]
        .filter(script => !script.disabled)
        .map(script => script.scriptName || 'unnamed');
}

const path = 'third-party/Extension-PromptRegex';

if (!('GENERATE_AFTER_COMBINE_PROMPTS' in event_types) || !('CHAT_COMPLETION_PROMPT_READY' in event_types)) {
    toastr.error('Required event types not found. Update SillyTavern to the latest version.');
    throw new Error('Events not found.');
}

function isChatCompletion() {
    return main_api === 'openai';
}

function addLaunchButton() {
    const enabledText = t`Stop Prompt Regexing`;
    const disabledText = t`Regex Raw Prompts`;
    const enabledIcon = 'fa-solid fa-bug-slash';
    const disabledIcon = 'fa-solid fa-bug';

    const getIcon = () => regexEnabled ? enabledIcon : disabledIcon;
    const getText = () => regexEnabled ? enabledText : disabledText;

    const launchButton = document.createElement('div');
    launchButton.id = 'regexNextPromptButton';
    launchButton.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    launchButton.tabIndex = 0;
    launchButton.title = t`Toggle Regex on Prompt`;
    const icon = document.createElement('i');
    icon.className = getIcon();
    launchButton.appendChild(icon);
    const textSpan = document.createElement('span');
    textSpan.textContent = getText();
    launchButton.appendChild(textSpan);

    const extensionsMenu = document.getElementById('prompt_regexer_wand_container') ?? document.getElementById('extensionsMenu');
    extensionsMenu.classList.add('interactable');
    extensionsMenu.tabIndex = 0;

    if (!extensionsMenu) {
        throw new Error('Could not find the extensions menu');
    }

    extensionsMenu.appendChild(launchButton);
    launchButton.addEventListener('click', () => {
        toggleRegexNext();
        textSpan.textContent = getText();
        icon.className = getIcon();
    });
}

let regexEnabled = localStorage.getItem('promptRegexerEnabled') === 'true' || false;

function toggleRegexNext() {
    regexEnabled = !regexEnabled;
    toastr.info(`Prompt regexing is now ${regexEnabled ? 'enabled' : 'disabled'}`);
    localStorage.setItem('promptRegexerEnabled', String(regexEnabled));
}

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (data) => {
    if (!regexEnabled) {
        return;
    }

    if (data.dryRun) {
        console.debug('Prompt Regexer: Skipping dry run prompt');
        return;
    }

    if (!isChatCompletion()) {
        console.debug('Prompt Regexer: Not a chat completion prompt');
        return;
    }

    // in-place: regex each .content only
    chatCopy = data.chat;
    chatCopy.forEach(message => {
        if (typeof message.content === 'string') {
            message.content = getRegexedString(
                message.content,
                regex_placement.AI_OUTPUT,
                { isPrompt: true }
            );
        }
    });
    console.debug('Prompt Regexer: All content fields regex’d');
    const promptJson = JSON.stringify(data.chat, null, 4);
    const chatCopyJson = JSON.stringify(chatCopy, null, 4);

    if (chatCopyJson === promptJson) {
        console.debug('Prompt Regexer: No changes');
        return;
    }

    try {
        const chat = JSON.parse(chatCopyJson);

        // Chat is passed by reference, so we can modify it directly
        if (Array.isArray(chat) && Array.isArray(data.chat)) {
            data.chat.splice(0, data.chat.length, ...chat);
        }

        console.debug('Prompt Regexer: Prompt updated');
    } catch (e) {
        console.error('Prompt Regexer: Invalid JSON');
        toastr.error('Invalid JSON');
    }
});

eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, async (data) => {
    if (!regexEnabled) {
        return;
    }

    if (data.dryRun) {
        console.debug('Prompt Regexer: Skipping dry run prompt');
        return;
    }

    if (isChatCompletion()) {
        console.debug('Prompt Regexer: Not a chat completion prompt');
        return;
    }

    const result = getRegexedString((data.prompt), regex_placement.AI_OUTPUT, {isPrompt: true});

    if (result === data.prompt) {
        console.debug('Prompt Regexer: No changes');
        return;
    }

    data.prompt = result;
    console.debug('Prompt Regexer: Prompt updated');
});

(function init() {
    addLaunchButton();
})();