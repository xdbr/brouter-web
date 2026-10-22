BR.Profile = L.Evented.extend({
    cache: {},
    storageKey: 'routingprofile.customText',
    libraryKey: 'routingprofile.library',

    initialize() {
        var textArea = L.DomUtil.get('profile_upload');
        this.editor = CodeMirror.fromTextArea(textArea, {
            lineNumbers: true,
        });

        $('#profileEditorTabs a[data-toggle="tab"]').on(
            'shown.bs.tab',
            L.bind(function (e) {
                this._activateSecondaryTab();
            }, this)
        );

        L.DomUtil.get('save').onclick = L.bind(this._save, this);
        L.DomUtil.get('upload').onclick = L.bind(this._upload, this);
        L.DomUtil.get('clear').onclick = L.bind(this.clear, this);

        this.pinned = L.DomUtil.get('profile-pinned');

        this.message = new BR.Message('profile_message', {
            alert: true,
        });
        this.savedProfiles = [];
        this.activeSavedId = null;
        this._loadLibrary();
        this._renderLibrary();
        L.DomUtil.get('saved-profile-name').form.onsubmit = (evt) => evt.preventDefault();
        L.DomUtil.get('saved-profiles').onchange = (evt) => {
            const id = evt.target.value;
            if (this._hasUnsavedChanges() && !window.confirm(i18next.t('sidebar.profile.discard'))) {
                this._renderLibrary();
                return;
            }
            if (id === '__default__') this.resetToDefault();
            else if (id) this.selectSavedProfile(id);
            else {
                this.activeSavedId = null;
                this._renderLibrary();
            }
        };
        L.DomUtil.get('profile-save-as').onclick = () => this.saveNamedProfile(false);
        L.DomUtil.get('profile-rename').onclick = () => this.saveNamedProfile(true);
        L.DomUtil.get('profile-delete').onclick = () => this.deleteSavedProfile();
        $('#profile_params').on('input change', 'input, select', () => this._markDefaultEdited());
        this.editor.on('change', (editor, change) => {
            if (change.origin !== 'setValue') this._markDefaultEdited();
        });
    },

    _markDefaultEdited() {
        if (!this.defaultSelected) return;
        this.defaultSelected = false;
        // Preserve the draft name and current controls while changing the label.
        L.DomUtil.get('saved-profiles').value = '';
    },

    clear(evt) {
        var button = evt.target || evt.srcElement;

        evt.preventDefault();

        this.activeSavedId = null;
        this._renderLibrary();
        this.editor.markClean();
        this._setValue('');

        try {
            localStorage.removeItem(this.storageKey);
            if (localStorage.getItem('routingprofile') === 'Custom') {
                localStorage.removeItem('routingprofile');
            }
        } catch (err) {
            // Clearing the editor must also work when storage is unavailable.
        }

        this.fire('clear');
        button.blur();
    },

    update(options, cb) {
        var profileName = options.profile,
            profileUrl,
            loading = false;

        if (profileName && !profileName.startsWith('custom_')) {
            this.activeSavedId = null;
            this.defaultSelected = profileName === BR.conf.profiles[0];
            this._renderLibrary();
        }
        if (profileName && BR.conf.profilesUrl) {
            this.selectedProfileName = profileName;

            if (!(profileName in this.cache)) {
                profileUrl = BR.conf.profilesUrl + profileName + '.brf';
                loading = true;
                BR.Util.get(
                    profileUrl,
                    L.bind(function (err, profileText) {
                        if (err) {
                            console.warn('Error getting profile from "' + profileUrl + '": ' + err);
                            if (cb) cb();
                            return;
                        }

                        this.cache[profileName] = profileText;

                        // don't set when option has changed while loading
                        if (!this.profileName || this.selectedProfileName === profileName) {
                            this._updateProfile(profileName, profileText);
                        }
                        if (cb) cb();
                    }, this)
                );
            } else {
                this._updateProfile(profileName, this.cache[profileName]);
            }
        }

        if (cb && !loading) cb();
    },

    _loadLibrary() {
        try {
            const raw = localStorage.getItem(this.libraryKey);
            if (raw) {
                const library = JSON.parse(raw);
                if (library.version !== 1 || !Array.isArray(library.profiles)) throw new Error('Invalid library');
                const ids = new Set();
                this.savedProfiles = library.profiles.filter((item) => {
                    if (
                        !item ||
                        typeof item.id !== 'string' ||
                        !item.id ||
                        ids.has(item.id) ||
                        typeof item.name !== 'string' ||
                        !item.name.trim() ||
                        typeof item.text !== 'string'
                    )
                        return false;
                    ids.add(item.id);
                    return true;
                });
                this.lastSavedId = library.activeId;
            } else {
                const text = localStorage.getItem(this.storageKey);
                if (text) {
                    this.savedProfiles = [{ id: 'migrated', name: i18next.t('sidebar.profile.migrated'), text }];
                    this.lastSavedId = 'migrated';
                    this._persistLibrary();
                }
            }
        } catch (err) {
            this.message.showWarning(i18next.t('sidebar.profile.storage-error'));
        }
    },

    _persistLibrary() {
        localStorage.setItem(
            this.libraryKey,
            JSON.stringify({
                version: 1,
                activeId: this.lastSavedId,
                profiles: this.savedProfiles,
            })
        );
    },

    _renderLibrary() {
        const select = L.DomUtil.get('saved-profiles');
        select.textContent = '';
        const draft = document.createElement('option');
        draft.value = '';
        draft.textContent = i18next.t('sidebar.profile.unsaved');
        select.appendChild(draft);
        const defaultOption = document.createElement('option');
        defaultOption.value = '__default__';
        defaultOption.textContent = i18next.t('sidebar.profile.default');
        select.appendChild(defaultOption);
        this.savedProfiles.forEach((item) => {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = item.name;
            select.appendChild(option);
        });
        select.value = this.activeSavedId || (this.defaultSelected ? '__default__' : '');
        const active = this.savedProfiles.find((item) => item.id === this.activeSavedId);
        L.DomUtil.get('saved-profile-name').value = active ? active.name : '';
        L.DomUtil.get('profile-rename').disabled = !active;
        L.DomUtil.get('profile-delete').disabled = !active;
        this.fire('name', {
            name: active ? active.name : null,
            profiles: this.savedProfiles,
            activeId: this.activeSavedId,
        });
    },

    _currentText() {
        const text = this._getProfileText();
        return this._isParamsFormActive() ? this._buildCustomProfile(text) : text;
    },

    _hasUnsavedChanges() {
        const active = this.savedProfiles.find((item) => item.id === this.activeSavedId);
        return active
            ? this._currentText() !== active.text
            : !this.editor.isClean() || this._currentText() !== this._getProfileText();
    },

    saveNamedProfile(rename) {
        const input = L.DomUtil.get('saved-profile-name');
        const name = input.value.trim();
        const active = this.savedProfiles.find((item) => item.id === this.activeSavedId);
        if (
            !name ||
            name.length > 100 ||
            this.savedProfiles.some(
                (item) => item.name.toLowerCase() === name.toLowerCase() && (!rename || item.id !== this.activeSavedId)
            )
        ) {
            this.message.showError(i18next.t('sidebar.profile.unique-name'));
            return false;
        }
        if (rename && !active) return false;
        const text = rename ? active.text : this._currentText();
        if (!text.trim()) {
            this.message.showError(i18next.t('sidebar.profile.empty'));
            return false;
        }
        const previous = this.savedProfiles;
        const previousId = this.lastSavedId;
        const item = rename
            ? { ...active, name }
            : { id: 'saved_' + Date.now() + '_' + Math.random().toString(36).slice(2), name, text };
        this.savedProfiles = rename
            ? previous.map((entry) => (entry.id === item.id ? item : entry))
            : previous.concat(item);
        this.lastSavedId = item.id;
        try {
            this._persistLibrary();
        } catch (err) {
            this.savedProfiles = previous;
            this.lastSavedId = previousId;
            this.message.showWarning(i18next.t('sidebar.profile.storage-error'));
            return false;
        }
        this.activeSavedId = item.id;
        this._renderLibrary();
        if (!rename) this._applySavedText(text);
        return true;
    },

    selectSavedProfile(id) {
        const item = this.savedProfiles.find((entry) => entry.id === id);
        if (!item) return false;
        this.activeSavedId = id;
        this.lastSavedId = id;
        this._renderLibrary();
        this._applySavedText(item.text);
        return true;
    },

    deleteSavedProfile() {
        const id = this.activeSavedId;
        if (!id || !window.confirm(i18next.t('sidebar.profile.confirm-delete'))) return;
        const previous = this.savedProfiles;
        const previousId = this.lastSavedId;
        this.savedProfiles = previous.filter((item) => item.id !== id);
        if (this.lastSavedId === id) this.lastSavedId = null;
        try {
            this._persistLibrary();
        } catch (err) {
            this.savedProfiles = previous;
            this.lastSavedId = previousId;
            this.message.showWarning(i18next.t('sidebar.profile.storage-error'));
            return;
        }
        this.resetToDefault();
    },

    resetToDefault() {
        this.activeSavedId = null;
        this.defaultSelected = true;
        this.profileName = null;
        this.selectedProfileName = BR.conf.profiles[0];
        L.DomUtil.get('profile_params').textContent = '';
        this.editor.markClean();
        this._setValue('');
        this._renderLibrary();
        try {
            localStorage.removeItem(this.storageKey);
            localStorage.setItem('routingprofile', BR.conf.profiles[0]);
        } catch (err) {
            this.message.showWarning(i18next.t('sidebar.profile.storage-error'));
        }
        this.fire('default');
    },

    rememberCustomProfile(profileText) {
        const previous = this.savedProfiles;
        const previousId = this.lastSavedId;
        try {
            const active = this.savedProfiles.find((item) => item.id === this.activeSavedId);
            this.savedProfiles = previous.map((item) =>
                item.id === this.activeSavedId ? { ...item, text: profileText } : item
            );
            this.lastSavedId = active ? active.id : null;
            this._persistLibrary();
            localStorage.setItem(this.storageKey, profileText);
            localStorage.setItem('routingprofile', 'Custom');
        } catch (err) {
            this.savedProfiles = previous;
            this.lastSavedId = previousId;
            this.message.showWarning(i18next.t('sidebar.profile.storage-error'));
        }
    },

    restoreCustomProfile() {
        let profileText;
        try {
            if (localStorage.getItem('routingprofile') !== 'Custom') return false;
            const active = this.savedProfiles.find((item) => item.id === this.lastSavedId);
            if (active) return this.selectSavedProfile(active.id);
            profileText = localStorage.getItem(this.storageKey);
        } catch (err) {
            return false;
        }
        if (!profileText) return false;
        this._applySavedText(profileText);
        return true;
    },

    _applySavedText(profileText) {
        this.defaultSelected = false;
        this.profileName = 'Custom';
        this.selectedProfileName = 'Custom';
        this._setValue(profileText);
        this.editor.markClean();
        this.fire('update', {
            profileText,
            restoring: true,
            callback: (err, profileId) => {
                if (!err) {
                    this.profileName = profileId;
                    this.selectedProfileName = profileId;
                    this.cache[profileId] = profileText;
                }
            },
        });
    },

    show() {
        this.editor.refresh();
    },

    onResize() {
        this.editor.refresh();
    },

    // Returns the initial value of the given profile variable as String, as defined by the assign statement.
    // Intended for all assigned variables, not just parameters with a comment declaration, i.e. no type information used.
    getProfileVar(name) {
        let value;
        if (this._isParamsFormActive()) {
            const formValues = this._getFormValues();
            if (formValues.hasOwnProperty(name)) {
                return formValues[name];
            }
        }

        const profileText = this._getSelectedProfileText();
        if (!profileText) return value;

        const regex = new RegExp(`assign\\s*${name}\\s*=?\\s*([\\w\\.]*)`);
        const match = profileText.match(regex);
        if (match) {
            value = match[1];
        }
        return value;
    },

    // Returns car|bike|foot, default is foot
    getTransportMode() {
        const isCar = !!this.getProfileVar('validForCars');
        const isBike = !!this.getProfileVar('validForBikes');
        return isCar ? 'car' : isBike ? 'bike' : 'foot';
    },

    _upload(evt) {
        var button = evt.target || evt.srcElement,
            profile = this._getProfileText();

        this.message.hide();
        evt.preventDefault();

        this.fire('update', {
            profileText: profile,
            callback: L.bind(function (err, profileId, profileText) {
                $(button).blur();
                if (!err) {
                    this.profileName = profileId;
                    this.cache[profileId] = profileText;
                }
            }, this),
        });
    },

    _buildCustomProfile(profileText) {
        const formValues = this._getFormValues();
        Object.keys(formValues).forEach((name) => {
            const value = formValues[name];
            var re = new RegExp(
                '(assign\\s*' +
                    name +
                    '\\s*=?\\s*)([\\w.]*)(\\s*#\\s*%(.*)%\\s*(\\|\\s*(.*)\\s*\\|\\s*(.*)\\s*)?[\\r\\n])'
            );
            profileText = profileText.replace(re, function (match, p1, p2, p3) {
                return p1 + value + p3;
            });
        });
        return profileText;
    },

    _getFormValues() {
        const obj = {};
        document.querySelectorAll('#profile_params input, #profile_params select').forEach((input) => {
            const name = input.name;
            let value;
            if (input.type == 'checkbox') {
                value = input.checked;
            } else {
                value = input.value;
            }
            obj[name] = value;
        });
        return obj;
    },

    _save(evt) {
        var profileText = this._buildCustomProfile(this._getProfileText());
        var that = this;
        this.fire('update', {
            profileText,
            callback(err, profileId, profileText) {
                if (!err) {
                    that.profileName = profileId;
                    that.cache[profileId] = profileText;
                }
            },
        });
    },

    _updateProfile(profileName, profileText) {
        const empty = !this.editor.getValue();
        const clean = this.editor.isClean();

        // only synchronize profile editor/parameters with selection if no manual changes in full editor,
        // else keep custom profile pinned - to prevent changes in another profile overwriting previous ones
        if (empty || clean) {
            this.profileName = profileName;
            this._setValue(profileText);

            if (!this.pinned.hidden) {
                this.pinned.hidden = true;
            }
        } else {
            if (this.pinned.hidden) {
                this.pinned.hidden = false;
            }
        }
    },

    _setValue(profileText) {
        profileText = profileText || '';

        var clean = this.editor.isClean();

        // Always set value of the full editor, even if not active.
        // Full editor is master, the parameter form always gets the text from it (not cache).
        this.editor.setValue(profileText);

        // keep dirty state (manually modified; setValue also sets dirty)
        if (clean) {
            this.editor.markClean();
        }

        if (this._isParamsFormActive()) {
            this._buildParamsForm(profileText);
        }
    },

    _buildParamsForm(profileText) {
        if (!profileText) return;

        // Otherwise, create user friendly form
        var params = {};
        var global = profileText.split('---context:').filter(function (e) {
            return e.startsWith('global');
        });
        if (global && global.length > 0) {
            // Remove ---context:global line
            global = global[0].split('\n').slice(1);

            // Comment is mandatory
            var assignRegex = /assign\s*(\w*)\s*=?\s*([\w\.]*)\s*#\s*%(.*)%\s*(\|\s*(.*)\s*\|\s*(.*)\s*)?$/;
            global.forEach(function (item) {
                var match = item.match(assignRegex);
                var value;
                if (match) {
                    var name = match[1];
                    var value = match[2];
                    var description = match[5];

                    // Find out type
                    var paramType = match[6];
                    var paramValues = {};
                    if (paramType.match(/\[.*\]/)) {
                        paramType
                            .slice(1, -1)
                            .split(',')
                            .forEach(function (option) {
                                var splitOption = option.split('=');
                                var value = (splitOption[0] || '').replace(/^\s+|\s+$/g, '');
                                var description = (splitOption[1] || '').replace(/^\s+|\s+$/g, '');
                                paramValues[value] = description;
                            });
                        paramType = 'select';
                    }

                    // Type is missing, let's try to induce it from value
                    if (!paramType) {
                        if (value == 'true' || value == 'false') {
                            paramType = 'boolean';
                        } else {
                            paramType = 'number';
                        }
                    }

                    // Sanitize value according to type
                    if (paramType == 'boolean') {
                        value = value == 'true';
                    } else if (paramType == 'number') {
                        value = Number.parseFloat(value);
                        if (Number.isNaN(value)) {
                            return;
                        }
                    }

                    params[name] = {
                        description,
                        type: paramType,
                        value,
                        possible_values: paramValues,
                    };
                }
            });
        }
        var paramsSection = L.DomUtil.get('profile_params');
        paramsSection.innerHTML = '';

        if (!Object.keys(params).length) {
            paramsSection.append(i18next.t('sidebar.profile.no_easy_configuration_warning'));
        }

        Object.keys(params).forEach(function (param) {
            var div = document.createElement('div');
            var label = document.createElement('label');

            var paramType = params[param].type;
            var paramName = i18next.exists('profileParameters.' + param + '.name')
                ? i18next.t('profileParameters.' + param + '.name')
                : param;
            if (paramType == 'select') {
                var select = document.createElement('select');
                select.name = paramName;
                select.className = 'form-control form-control-sm';
                label.htmlFor = select.id = 'customize-profile-' + paramName;

                var paramValues = params[param].possible_values;
                Object.keys(paramValues).forEach(function (paramValue) {
                    var option = document.createElement('option');
                    option.value = paramValue;
                    if (paramValue == params[param].value) {
                        option.selected = true;
                    }
                    option.append(paramValues[paramValue]);
                    select.appendChild(option);
                });

                label.append(paramName);
                div.appendChild(label);
                div.appendChild(select);
            } else {
                var input = document.createElement('input');
                input.name = paramName;
                label.htmlFor = input.id = 'customize-profile-' + paramName;
                if (paramType == 'number') {
                    input.type = 'number';
                    input.value = params[param].value;
                    input.className = 'form-control form-control-sm';

                    label.append(paramName);
                    div.appendChild(label);
                    div.appendChild(input);
                    div.className = 'form-group';
                } else if (paramType == 'boolean') {
                    input.type = 'checkbox';
                    input.checked = params[param].value;

                    div.appendChild(input);
                    label.append(paramName);
                    div.appendChild(label);
                } else {
                    // Unknown parameter type, skip it
                    return;
                }
            }

            var helpBlock = document.createElement('p');
            var description = i18next.exists('profileParameters.' + param + '.description')
                ? i18next.t('profileParameters.' + param + '.description')
                : params[param].description.replace(/^\s+|\s+$/g, '');
            helpBlock.innerHTML = description;
            helpBlock.className = 'help-block';

            div.appendChild(helpBlock);
            paramsSection.appendChild(div);
        });
    },

    _isParamsFormActive() {
        return L.DomUtil.get('profile_params_container').classList.contains('active');
    },

    _activateSecondaryTab() {
        var profileText = this._getProfileText();

        if (this._isParamsFormActive()) {
            this._buildParamsForm(profileText);
        } else {
            this._setValue(this._buildCustomProfile(profileText));
        }
    },

    _getProfileText() {
        return this.editor.getValue();
    },

    _getSelectedProfileText() {
        return this.cache[this.selectedProfileName] ?? this.editor.getValue();
    },
});
